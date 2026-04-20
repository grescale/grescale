import { Hono } from "hono";
import sql from "../db/db.ts";
import { countCustomEndpointFiles } from "../customScripts.ts";
import { renderTemplate } from "../views/templateEngine.ts";
import { assertReadOnlySqlQuery, buildSafeSqlFilter } from "../sqlSafety.ts";
import {
  COMMON_TIMEZONES,
  DEFAULT_APP_TIMEZONE,
  DEFAULT_PG_BACKUP_SETTINGS,
  PG_BACKUP_DIR,
  PG_BACKUP_FREQUENCIES,
  PG_BACKUP_INTERVAL_MS,
  type PgBackupFrequency,
  type PgBackupSettings,
  applyPgBackupRetention,
  convertLocalDateTimeInTimeZoneToUtcIso,
  ensureBackupDir,
  ensurePgBackupSchedulerStarted,
  formatBytes,
  formatDateOnlyForInput,
  formatDateTimeForInput,
  getConfiguredTimeZone,
  getCollectionsBasePath,
  getDatePartsInTimeZone,
  getPgBackupSettings,
  isValidIanaTimeZone,
  listPgBackupFiles,
  makePgBackupFilename,
  normalizePgBackupFrequency,
  normalizeRetainCount,
  quoteIdentifier,
  restorePgDumpBackup,
  runPgDumpBackupOnce,
  runScheduledPgBackupIfDue,
  safeTimeZone,
  sanitizeBackupFilename,
  savePgBackupSettings,
} from "../services/collectionsBackend.ts";

export const collections = new Hono();

function htmxErrorResponse(message: string, status = 422) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function escapeSqlConstraintLiteral(value: string) {
  return value.replace(/'/g, "''");
}

function buildSqlConstraintName(
  collectionName: string,
  fieldName: string,
  suffix: string,
) {
  const rawName = `ck_${collectionName}_${fieldName}_${suffix}`
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_");
  return rawName.slice(0, 63);
}

function buildFieldSqlType(field: any) {
  let safeType = String(field.type || "text")
    .toLowerCase()
    .trim();
  switch (safeType) {
    case "text":
    case "richtext":
    case "email":
    case "url":
    case "file":
      return "TEXT";
    case "number":
      return "NUMERIC";
    case "boolean":
    case "bool":
      return "BOOLEAN";
    case "json":
    case "jsonb":
    case "geolocation":
      return "JSONB";
    case "date":
    case "datetime":
      return "TIMESTAMP WITH TIME ZONE";
    case "date_only":
      return "VARCHAR(10)";
    case "relation":
      if (field.relation_collection) {
        if (!/^[a-zA-Z0-9_]+$/.test(field.relation_collection)) {
          throw new Error(
            `Invalid relation collection: ${field.relation_collection}`,
          );
        }
        return `UUID REFERENCES "${field.relation_collection}"(id)`;
      }
      return "UUID";
    case "uuid":
      return "UUID";
    default:
      return field.type.replace(/[^a-zA-Z0-9_\(\)]/g, "");
  }
}

function buildFieldChecks(field: any, fieldName: string, tableName: string) {
  const checks: Array<{ suffix: string; expression: string }> = [];
  const type = String(field.type || "text").toLowerCase();

  if (field.required) {
    checks.push({
      suffix: "required",
      expression: `"${fieldName.replace(/"/g, '""')}" IS NOT NULL`,
    });
  }

  if (type === "text" && field.regex) {
    checks.push({
      suffix: "regex",
      expression: `"${fieldName.replace(/"/g, '""')}" ~ '${escapeSqlConstraintLiteral(String(field.regex))}'`,
    });
  }

  if (type === "number") {
    const quoted = `"${fieldName.replace(/"/g, '""')}"`;
    if (field.nonzero) {
      checks.push({ suffix: "nonzero", expression: `${quoted} != 0` });
    }
    if (field.min !== undefined && field.min !== "") {
      checks.push({
        suffix: "min",
        expression: `${quoted} >= ${Number(field.min)}`,
      });
    }
    if (field.max !== undefined && field.max !== "") {
      checks.push({
        suffix: "max",
        expression: `${quoted} <= ${Number(field.max)}`,
      });
    }
  }

  return checks;
}

function buildFieldColumnDefinition(field: any) {
  const columnName = field.name.replace(/"/g, '""');
  const columnType = buildFieldSqlType(field);
  return `"${columnName}" ${columnType}${field.required ? " NOT NULL" : ""}`;
}

function shouldTrimTextInput(fieldDef: any) {
  const fieldType = String(fieldDef?.type || "").toLowerCase();
  return (
    fieldDef &&
    fieldDef.trim_input === true &&
    (fieldType === "text" || fieldType === "richtext")
  );
}

function normalizeTextInputValue(fieldDef: any, rawValue: any) {
  if (!shouldTrimTextInput(fieldDef)) {
    return rawValue;
  }

  return typeof rawValue === "string"
    ? rawValue.trim()
    : String(rawValue).trim();
}

function isUsersCollection(collectionName: string) {
  return collectionName === "_users";
}

async function getCurrentAdminRecord(c: any) {
  const sessionUser = c.get("user");
  if (!sessionUser?.id) return null;
  const rows = await sql`
    SELECT id, owner
    FROM _users
    WHERE id = ${sessionUser.id}
    LIMIT 1
  `;
  return rows[0] || null;
}

async function syncFieldSqlConstraints(
  tableName: string,
  field: any,
  previousName?: string,
) {
  const currentName = String(field.name);
  const currentChecks = buildFieldChecks(field, currentName, tableName);
  const namesToDrop = new Set<string>([
    currentName,
    previousName || currentName,
  ]);

  for (const fieldName of namesToDrop) {
    const currentField = String(fieldName);
    for (const suffix of ["required", "regex", "nonzero", "min", "max"]) {
      await sql.unsafe(
        `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${buildSqlConstraintName(tableName, currentField, suffix)}"`,
      );
    }
  }

  for (const check of currentChecks) {
    await sql.unsafe(
      `ALTER TABLE "${tableName}" ADD CONSTRAINT "${buildSqlConstraintName(tableName, currentName, check.suffix)}" CHECK (${check.expression}) NOT VALID`,
    );
  }
}

collections.get("/new", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  let globalGoogleEnabled = false;
  const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name NOT LIKE '\_%'
      ORDER BY table_name
  `;
  const tableNames = tables.map((t) => t.table_name);
  try {
    const googleSetting =
      await sql`SELECT value FROM _settings WHERE key = 'google_oauth' LIMIT 1`;
    if (googleSetting.length > 0) {
      const parsed = JSON.parse(googleSetting[0].value);
      globalGoogleEnabled = parsed?.enabled === true;
    }
  } catch (e) {}

  const formHtml = `
    <div data-drawer-backdrop class="fixed inset-0 z-50 bg-black/50 flex justify-end transition-opacity" onclick="if(event.target===this) window.closeDrawer()">
      <div data-drawer-panel class="w-full max-w-2xl bg-background shadow-xl h-full flex flex-col border-l border-border transform translate-x-0" onclick="event.stopPropagation()">
        <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/20">
          <h2 class="text-xl font-bold text-foreground">New Collection</h2>
          <button type="button" onclick="window.closeDrawer()" class="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground">
            <svg class="w-5 h-5 block" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        
        <form id="new-collection-form" hx-post="${collectionsBase}" hx-target="#main-content" class="flex flex-col h-full overflow-hidden">
          <input type="hidden" name="fields" id="hidden-fields" value="[]" />
          <input type="hidden" name="indexes" id="hidden-indexes" value="[]" />
          
          <div class="flex-1 overflow-y-auto p-6 space-y-6">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">Collection Name *</label>
                <input type="text" name="name" class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" placeholder="e.g. posts, comments, products" required title="Only alphanumeric characters and underscores allowed. Spaces will be converted.">
              </div>
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">Type</label>
                <select name="type" onchange="window.updateNewCollectionType(this.value)" class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                  <option value="base">Base Collection</option>
                  <option value="auth">Auth Collection</option>
                  <option value="view">View Collection</option>
                </select>
              </div>
            </div>

            <div class="border-b border-border">
              <div class="inline-flex gap-2 rounded-md bg-muted/40 p-1" role="tablist" aria-label="New collection tabs">
                <button type="button" data-new-tab-btn="field" onclick="window.switchNewCollectionTab('field')" class="h-8 px-3 rounded text-sm font-medium bg-background text-foreground shadow-sm">Field</button>
                <button type="button" data-new-tab-btn="rules" onclick="window.switchNewCollectionTab('rules')" class="h-8 px-3 rounded text-sm font-medium text-muted-foreground hover:text-foreground">Rules &amp; Options</button>
              </div>
            </div>

            <div id="new-tab-field" data-new-tab-panel="field" class="space-y-6">
              <div id="view-section" style="display: none;">
                <label class="block text-sm font-medium text-foreground mb-1">View Query (SELECT statement)</label>
                <textarea name="view_query" rows="4" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono" placeholder="SELECT id, email FROM _users"></textarea>
              </div>

              <div id="fields-section">
                <div class="flex items-center justify-between mb-4">
                  <label class="block text-sm font-medium text-foreground">Fields Configuration</label>
                  <button type="button" onclick="addField()" class="text-xs bg-primary/10 hover:bg-primary/20 text-primary px-3 py-1 rounded font-medium flex items-center gap-1 transition">
                    + New Field
                  </button>
                </div>
                <div id="fields-list" class="space-y-3">
                  <!-- Fields dynamically inserted here -->
                </div>
              </div>

              <div id="indexes-section" class="mt-6 border-t border-border pt-4">
                <div class="flex items-center justify-between mb-4">
                  <label class="block text-sm font-medium text-foreground">Indexes & Constraints</label>
                  <button type="button" onclick="addIndex()" class="text-xs bg-primary/10 hover:bg-primary/20 text-primary px-3 py-1 rounded font-medium flex items-center gap-1 transition">
                    + New Index / Unique
                  </button>
                </div>
                <div id="indexes-list" class="space-y-3">
                  <!-- Indexes dynamically inserted here -->
                </div>
              </div>
            </div>

            <div id="new-tab-rules" data-new-tab-panel="rules" class="space-y-6 hidden">
              <div id="auth-method-section" style="display: none;" class="text-sm bg-muted/30 p-4 rounded border">
                <label class="block font-medium text-foreground mb-2">Auth Method</label>
                <div class="flex gap-4">
                   <label class="flex items-center space-x-2">
                      <input type="radio" name="auth_method" value="email" checked class="text-primary focus:ring-primary w-4 h-4 border-input rounded">
                      <span>Email + Password</span>
                   </label>
                   <label class="flex items-center space-x-2">
                      <input type="radio" name="auth_method" value="username" class="text-primary focus:ring-primary w-4 h-4 border-input rounded">
                      <span>Username + Password</span>
                   </label>
                </div>

                <div class="mt-4 border-t border-border pt-4">
                  <h4 class="text-sm font-semibold text-foreground mb-2">OAuth2 Providers</h4>
                  ${
                    globalGoogleEnabled
                      ? `
                  <label class="flex items-center space-x-2">
                    <input type="checkbox" name="google_enabled" value="true" class="rounded border-input text-primary focus:ring-primary h-4 w-4">
                    <span class="text-sm font-medium">Enable Google Login for this collection</span>
                  </label>
                  <p class="text-xs text-muted-foreground mt-2">Callback URI: <code class="bg-muted px-1 py-0.5 rounded text-foreground">/api/collections/auth-with-oauth2/google/callback</code></p>
                  <p class="text-xs text-muted-foreground mt-1">The global Google OAuth configuration is already enabled in System Settings.</p>
                      `
                      : `
                      <p class="text-xs text-muted-foreground">Google OAuth2 is disabled globally. Enable it in <a href="#" onclick="window.closeDrawer()" hx-get="${collectionsBase}/system-settings" hx-target="#main-content" hx-push-url="/settings" class="text-primary hover:underline">System Settings</a>.</p>
                          `
                  }
                </div>
              </div>

              <div class="pt-4 border-t border-border">
                <h3 class="text-sm font-bold text-foreground mb-1">API Rules <span class="text-xs font-normal text-muted-foreground font-mono ml-2">(Admin only by default)</span></h3>
                <p class="text-xs text-muted-foreground mb-4 font-mono leading-relaxed">Press <code class="bg-muted px-1 py-0.5 rounded">/</code> or <code class="bg-muted px-1 py-0.5 rounded">Ctrl/⌥+Space</code> to show suggestions</p>
                <div class="space-y-5">
                  ${["List", "View", "Create", "Update", "Delete"]
                    .map(
                      (rule) => `
                    <div class="bg-muted/30 border border-border rounded-md p-4 rule-container">
                      <div class="flex items-center justify-between mb-2">
                        <label class="block text-sm font-semibold text-foreground">${rule} Rule</label>
                        <button type="button" class="rule-lock-btn p-1.5 text-muted-foreground hover:bg-muted rounded transition" data-rule-type="${rule.toLowerCase()}" data-locked="true" onclick="toggleRuleLock(this)">
                          <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1m0 20c-4.975 0-9-4.025-9-9s4.025-9 9-9 9 4.025 9 9-4.025 9-9 9m3.5-9c0 1.933-1.567 3.5-3.5 3.5S8.5 13.933 8.5 12 10.067 8.5 12 8.5s3.5 1.567 3.5 3.5"></path></svg>
                        </button>
                      </div>
                      <textarea name="${rule.toLowerCase()}_rule" placeholder="Admin only - click lock icon to edit" class="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none rule-input disabled:bg-muted disabled:cursor-not-allowed disabled:opacity-60" data-rule-type="${rule.toLowerCase()}" disabled></textarea>
                    </div>
                  `,
                    )
                    .join("")}
                </div>
              </div>
            </div>
          </div>
          
          <div class="p-4 border-t border-border bg-muted/10 flex justify-end gap-3">
            <button type="button" onclick="window.closeDrawer()" class="px-4 py-2 hover:bg-muted rounded-md text-sm font-medium transition">Cancel</button>
            <button type="submit" class="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-2 rounded-md text-sm font-medium transition shadow-sm">
              Create Collection
            </button>
          </div>
        </form>
      </div>
    </div>
    
    <script>
      window.switchNewCollectionTab = function(tab) {
        const fieldBtn = document.querySelector('[data-new-tab-btn="field"]');
        const rulesBtn = document.querySelector('[data-new-tab-btn="rules"]');
        const fieldPanel = document.querySelector('[data-new-tab-panel="field"]');
        const rulesPanel = document.querySelector('[data-new-tab-panel="rules"]');
        if (!fieldBtn || !rulesBtn || !fieldPanel || !rulesPanel) return;

        const showField = tab === 'field';
        fieldPanel.classList.toggle('hidden', !showField);
        rulesPanel.classList.toggle('hidden', showField);

        fieldBtn.className = showField
          ? 'h-8 px-3 rounded text-sm font-medium bg-background text-foreground shadow-sm'
          : 'h-8 px-3 rounded text-sm font-medium text-muted-foreground hover:text-foreground';
        rulesBtn.className = showField
          ? 'h-8 px-3 rounded text-sm font-medium text-muted-foreground hover:text-foreground'
          : 'h-8 px-3 rounded text-sm font-medium bg-background text-foreground shadow-sm';
      };

      window.updateNewCollectionType = function(type) {
        const fieldsSection = document.getElementById('fields-section');
        const indexesSection = document.getElementById('indexes-section');
        const viewSection = document.getElementById('view-section');
        const authMethodSection = document.getElementById('auth-method-section');
        if (!fieldsSection || !indexesSection || !viewSection || !authMethodSection) return;

        fieldsSection.style.display = type === 'view' ? 'none' : 'block';
        indexesSection.style.display = type === 'view' ? 'none' : 'block';
        viewSection.style.display = type === 'view' ? 'block' : 'none';
        authMethodSection.style.display = type === 'auth' ? 'block' : 'none';

        if (type === 'auth') {
          window.switchNewCollectionTab('rules');
        }
      };

      window.switchNewCollectionTab('field');

      window.RULE_COMPLETIONS = window.RULE_COMPLETIONS || [
        { text: '@request.auth.id', displayText: '@request.auth.id' },
        { text: '@request.auth.email', displayText: '@request.auth.email' },
        { text: '@request.body', displayText: '@request.body' },
        { text: '@request.query', displayText: '@request.query' },
        { text: '@request.method', displayText: '@request.method' },
        { text: '@request.collection.name', displayText: '@request.collection.name' },
        { text: '@record.id', displayText: '@record.id' },
        { text: '@record.owner_id', displayText: '@record.owner_id' },
        { text: '@record.created_at', displayText: '@record.created_at' },
        { text: 'exists(', displayText: 'exists(field)' },
        { text: 'len(', displayText: 'len(value)' },
        { text: 'lower(', displayText: 'lower(text)' },
        { text: 'upper(', displayText: 'upper(text)' },
        { text: 'trim(', displayText: 'trim(text)' },
        { text: 'contains(', displayText: 'contains(text, substring)' },
        { text: 'startsWith(', displayText: 'startsWith(text, prefix)' },
        { text: 'endsWith(', displayText: 'endsWith(text, suffix)' },
        { text: 'matches(', displayText: 'matches(text, regex)' },
        { text: 'coalesce(', displayText: 'coalesce(val1, val2, ...)' },
        { text: ' = ', displayText: '= (equals)' },
        { text: ' != ', displayText: '!= (not equals)' },
        { text: ' > ', displayText: '> (greater than)' },
        { text: ' < ', displayText: '< (less than)' },
        { text: ' >= ', displayText: '>= (greater or equal)' },
        { text: ' <= ', displayText: '<= (less or equal)' },
        { text: ' ~ ', displayText: '~ (contains)' },
        { text: ' !~ ', displayText: '!~ (not contains)' },
        { text: ' in ', displayText: 'in (array membership)' },
        { text: ' && ', displayText: '&& (and)' },
        { text: ' || ', displayText: '|| (or)' },
        { text: ' !', displayText: '! (not)' },
      ];

      window.loadRuleScript = window.loadRuleScript || function(src) {
        return new Promise((resolve, reject) => {
          let existing = document.querySelector('script[src="' + src + '"]');
          if (existing) {
            if (existing.dataset.loaded === '1') {
              resolve();
              return;
            }
            if (existing.dataset.failed === '1') {
              existing.remove();
              existing = null;
            }
          }

          if (existing) {
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error('Failed loading script: ' + src)), { once: true });
            return;
          }

          const script = document.createElement('script');
          script.src = src;
          script.async = true;
          script.onload = () => {
            script.dataset.loaded = '1';
            resolve();
          };
          script.onerror = () => {
            script.dataset.failed = '1';
            reject(new Error('Failed loading script: ' + src));
          };
          document.head.appendChild(script);
        });
      };

      window.ensureRuleAceCompleter = window.ensureRuleAceCompleter || function(ace) {
        if (window.__ruleAceCompleterReady) return;
        const Range = ace.require('ace/range').Range;
        const langTools = ace.require('ace/ext/language_tools');
        langTools.addCompleter({
          getCompletions: function(editor, session, pos, prefix, callback) {
            const token = (prefix || '').toLowerCase();
            const matches = window.RULE_COMPLETIONS
              .filter((item) => !token || item.displayText.toLowerCase().includes(token) || item.text.toLowerCase().includes(token))
              .map((item, idx) => ({
                caption: item.displayText,
                value: item.text,
                meta: 'rule',
                score: 1000 - idx,
              }));
            callback(null, matches);
          },
          insertMatch: function(editor, data) {
            const session = editor.getSession();
            const pos = editor.getCursorPosition();
            const line = session.getLine(pos.row) || '';
            if (pos.column > 0 && line.charAt(pos.column - 1) === '/') {
              session.remove(new Range(pos.row, pos.column - 1, pos.row, pos.column));
            }
            const insertText = (data && (data.value || data.caption || data.snippet)) || '';
            if (insertText) {
              editor.insert(insertText);
            }
          },
        });
        window.__ruleAceCompleterReady = true;
      };

      window.applyRuleEditorState = window.applyRuleEditorState || function(textarea) {
        const editor = textarea._aceEditor;
        if (!editor) return;
        const isDisabled = textarea.disabled;
        editor.setReadOnly(isDisabled);
        editor.container.classList.toggle('opacity-60', isDisabled);
        editor.container.style.pointerEvents = isDisabled ? 'none' : 'auto';
        editor.container.style.cursor = isDisabled ? 'not-allowed' : 'text';
        editor.container.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
        const cursorLayer = editor.renderer?.$cursorLayer?.element;
        if (cursorLayer) {
          cursorLayer.style.display = isDisabled ? 'none' : 'block';
        }
        if (isDisabled && typeof editor.blur === 'function') {
          editor.blur();
        }
      };

      window.initializeRuleEditors = window.initializeRuleEditors || async function(root) {
        try {
          await window.loadRuleScript('https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.0/ace.min.js');
          await window.loadRuleScript('https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.0/ext-language_tools.min.js');
        } catch (err) {
          if (typeof showToast === 'function') {
            showToast('Failed to load rule autocomplete library (Ace).', 'error');
          }
          return;
        }

        const ace = window.ace;
        if (!ace) return;
        window.ensureRuleAceCompleter(ace);

        root.querySelectorAll('.rule-input').forEach((textarea) => {
          if (textarea._aceEditor) {
            window.applyRuleEditorState(textarea);
            return;
          }

          const editorEl = document.createElement('div');
          editorEl.className = 'w-full border border-input rounded-md bg-background text-sm font-mono';
          editorEl.style.minHeight = textarea.classList.contains('h-24') ? '96px' : '80px';
          editorEl.style.padding = '8px 10px';
          editorEl.style.lineHeight = '1.45';

          textarea.style.display = 'none';
          textarea.insertAdjacentElement('afterend', editorEl);

          const editor = ace.edit(editorEl);
          editor.session.setMode('ace/mode/text');
          editor.session.setValue(textarea.value || '');
          editor.session.setUseWrapMode(true);
          editor.setShowPrintMargin(false);
          editor.setOption('highlightActiveLine', false);
          editor.setOption('showLineNumbers', false);
          editor.setOption('showGutter', false);
          editor.setOptions({
            fontSize: '13px',
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: false,
          });

          editor.commands.addCommand({
            name: 'manualAutocomplete',
            bindKey: { win: 'Ctrl-Space', mac: 'Command-Space' },
            exec: function(ed) {
              ed.execCommand('startAutocomplete');
            },
          });

          editor.on('change', function() {
            textarea.value = editor.getValue();
          });
          editor.commands.on('afterExec', function(e) {
            if (textarea.disabled) return;
            if (e.command && e.command.name === 'insertstring' && e.args === '/') {
              const pos = editor.getCursorPosition();
              const session = editor.getSession();
              if (pos.column > 0) {
                const Range = ace.require('ace/range').Range;
                session.remove(new Range(pos.row, pos.column - 1, pos.row, pos.column));
              }
              editor.execCommand('startAutocomplete');
            }
          });

          textarea._aceEditor = editor;
          window.applyRuleEditorState(textarea);
        });
      };

      window.initializeRuleEditors(document);
      setTimeout(() => window.initializeRuleEditors(document), 0);

      // Toggle rule lock/unlock
      window.toggleRuleLock = async function(btn) {
        const container = btn.closest('.rule-container');
        const textarea = container?.querySelector('.rule-input');
        if (!textarea) return;
        let editor = textarea._aceEditor;
        
        const isLocked = btn.dataset.locked === 'true';
        
        if (isLocked) {
          // Unlock
          textarea.disabled = false;
          textarea.placeholder = 'Write your rule here...';
          btn.dataset.locked = 'false';
          btn.innerHTML = '<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10h12V7c0-.551.449-1 1-1s1 .449 1 1v3h1c.551 0 1 .449 1 1v10c0 .551-.449 1-1 1H6c-.551 0-1-.449-1-1V11c0-.551.449-1 1-1h1V7c0-3.866 3.134-7 7-7s7 3.134 7 7v2c0 .551-.449 1-1 1s-1-.449-1-1V7c0-2.757-2.243-5-5-5s-5 2.243-5 5v3z"></path></svg>';
          await window.initializeRuleEditors(container || document);
          editor = textarea._aceEditor;
          window.applyRuleEditorState(textarea);
          if (editor) {
            editor.focus();
          } else {
            textarea.focus();
          }
        } else {
          // Lock
          textarea.disabled = true;
          textarea.placeholder = 'Admin only - click lock icon to edit';
          textarea.value = '';
          if (editor) editor.session.setValue('');
          btn.dataset.locked = 'true';
          btn.innerHTML = '<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1m0 20c-4.975 0-9-4.025-9-9s4.025-9 9-9 9 4.025 9 9-4.025 9-9 9m3.5-9c0 1.933-1.567 3.5-3.5 3.5S8.5 13.933 8.5 12 10.067 8.5 12 8.5s3.5 1.567 3.5 3.5"></path></svg>';
          window.applyRuleEditorState(textarea);
        }
      };

      (function() {
        let fieldCounter = 0;
        let indexCounter = 0;
        const container = document.getElementById('fields-list');
        const indexesContainer = document.getElementById('indexes-list');
        const collectionOptions = \`${tableNames.map((t) => `<option value="${t}">${t}</option>`).join("")}\`;
        
        window.addField = function() {
          const id = 'field-' + fieldCounter++;
          const html = \`<div class="bg-card border border-border shadow-sm rounded-md p-3 relative group" id="\${id}">
            <div class="flex items-center gap-3">
              <div class="flex-1">
                <input type="text" class="field-name flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Field name" required>
              </div>
              <div class="w-40">
                <select class="field-type flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="text">Plain Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                  <option value="email">Email</option>
                  <option value="url">URL</option>
                  <option value="date">Date/Time</option>
                  <option value="date_only">Date Only</option>
                  <option value="richtext">Rich Text</option>
                  <option value="json">JSON</option>
                  <option value="file">File</option>
                  <option value="relation">Relation (UUID)</option>
                </select>
              </div>
              <div class="w-40 hidden field-relation-settings">
                <select class="field-relation-collection flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  \${collectionOptions}
                </select>
              </div>
              <button type="button" onclick="toggleFieldSettings('\${id}')" class="p-2 text-muted-foreground hover:bg-accent hover:text-foreground rounded transition" title="Field Settings">
                 <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
              <button type="button" onclick="document.getElementById('\${id}').remove()" class="p-2 text-red-500/70 hover:bg-red-50 hover:text-red-600 rounded transition" title="Remove field">
                 <span class="text-xs font-bold">🗑️</span>
              </button>
            </div>
            
            <div class="field-settings hidden mt-3 pt-3 border-t border-border grid grid-cols-2 gap-4 bg-muted/20 px-3 py-4 rounded -mx-3 -mb-3">
              <div class="col-span-2 mt-2 field-text-settings hidden">
                <label class="block text-xs font-medium text-foreground mb-1">Regex Validation</label>
                <input type="text" class="field-regex flex h-8 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="e.g. ^[a-z]+$">
                  <div class="mt-3 flex items-center space-x-2 field-trim-wrapper hidden">
                    <input type="checkbox" class="field-trim-input rounded border-input text-primary w-4 h-4 shadow-sm">
                    <label class="text-sm font-medium">Trim Input</label>
                  </div>
              </div>
              
              <div class="col-span-2 flex items-center gap-6 mt-1 mb-2">
                <div class="flex items-center space-x-2">
                  <input type="checkbox" class="field-required rounded border-input text-primary w-4 h-4 shadow-sm">
                  <label class="text-sm font-medium">Required (Not Empty)</label>
                </div>
                <div class="flex items-center space-x-2 field-nonzero-wrapper hidden">
                  <input type="checkbox" class="field-nonzero rounded border-input text-primary w-4 h-4 shadow-sm">
                  <label class="text-sm font-medium">Non-Zero</label>
                </div>
              </div>

              <div class="col-span-2 grid grid-cols-2 gap-4 mt-2 field-number-settings hidden">
                <div>
                  <label class="block text-xs font-medium text-foreground mb-1">Min Value</label>
                  <input type="number" class="field-min flex h-8 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                </div>
                <div>
                  <label class="block text-xs font-medium text-foreground mb-1">Max Value</label>
                  <input type="number" class="field-max flex h-8 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                </div>
              </div>

              <div class="col-span-2 mt-2 field-date-settings hidden">
                <label class="block text-xs font-medium text-foreground mb-1">Date Format</label>
                <select class="field-date-format flex h-8 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="DD-MM-YYYY">DD-MM-YYYY</option>
                  <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                  <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  <option value="YYYY/MM/DD">YYYY/MM/DD</option>
                </select>
              </div>
            </div>
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">passwordConfirm</label>
            <input type="password" name="passwordConfirm" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
          </div>
          const dateSettings = el.querySelector('.field-date-settings');
          const trimWrapper = el.querySelector('.field-trim-wrapper');

          const syncFieldSettings = function() {
            const value = typeSelect ? typeSelect.value : 'text';

            if (textSettings) textSettings.classList.add('hidden');
            if (numSettings) numSettings.classList.add('hidden');
            if (relationSettings) relationSettings.classList.add('hidden');
            if (nonZeroWrapper) nonZeroWrapper.classList.add('hidden');
            if (dateSettings) dateSettings.classList.add('hidden');
            if (trimWrapper) trimWrapper.classList.add('hidden');

            if (value === 'number') {
              if (numSettings) numSettings.classList.remove('hidden');
              if (nonZeroWrapper) nonZeroWrapper.classList.remove('hidden');
            } else if (value === 'text') {
              if (textSettings) textSettings.classList.remove('hidden');
              if (trimWrapper) trimWrapper.classList.remove('hidden');
            } else if (value === 'relation') {
              if (relationSettings) relationSettings.classList.remove('hidden');
            } else if (value === 'date_only') {
              if (dateSettings) dateSettings.classList.remove('hidden');
            } else if (value === 'richtext' || value === 'json' || value === 'file' || value === 'email' || value === 'url') {
              if (textSettings) textSettings.classList.remove('hidden');
              if (value === 'richtext' && trimWrapper) trimWrapper.classList.remove('hidden');
            }
          };

          if (typeSelect) {
            typeSelect.addEventListener('change', syncFieldSettings);
            syncFieldSettings();
          }
        };

        window.addIndex = function() {
          const id = 'index-' + indexCounter++;
          const html = \`<div class="bg-card border border-border shadow-sm rounded-md p-3 relative flex items-center gap-3" id="\${id}">
            <div class="flex-1">
              <input type="text" class="index-fields flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Comma separated fields (e.g. email, username)" required>
            </div>
            <div class="w-32">
              <select class="index-type flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="index">Index</option>
                <option value="unique">Unique</option>
              </select>
            </div>
            <button type="button" onclick="document.getElementById('\${id}').remove()" class="p-2 text-red-500/70 hover:bg-red-50 hover:text-red-600 rounded transition" title="Remove index">
               <span class="text-xs font-bold">🗑️</span>
            </button>
          </div>\`;
          indexesContainer.insertAdjacentHTML('beforeend', html);
        };
        
        window.toggleFieldSettings = function(id) {
          const settings = document.getElementById(id).querySelector('.field-settings');
          settings.classList.toggle('hidden');
        };
        
        // Marshall fields on submit
        document.body.addEventListener('htmx:configRequest', function(e) {
          if (e.target.id === 'new-collection-form') {
             if(document.querySelector('select[name="type"]').value !== 'view') {
                 const fieldEls = container.querySelectorAll('.bg-card');
                 const fieldsArr = [];
                 fieldEls.forEach(function(el) {
                    const type = el.querySelector('.field-type').value;
                    const fieldObj = {
                       name: el.querySelector('.field-name').value,
                       type: type,
                       required: el.querySelector('.field-required').checked,
                       unique: el.querySelector('.field-unique') ? el.querySelector('.field-unique').checked : false,
                       index: el.querySelector('.field-index') ? el.querySelector('.field-index').checked : false,
                    };
                    if (type === 'number') {
                       fieldObj.nonzero = el.querySelector('.field-nonzero').checked;
                    }
                    if (type === 'number') {
                       fieldObj.min = el.querySelector('.field-min').value;
                       fieldObj.max = el.querySelector('.field-max').value;
                    } else if (type === 'text') {
                       fieldObj.regex = el.querySelector('.field-regex').value;
                        fieldObj.trim_input = el.querySelector('.field-trim-input') ? el.querySelector('.field-trim-input').checked : false;
                      } else if (type === 'richtext') {
                        fieldObj.trim_input = el.querySelector('.field-trim-input') ? el.querySelector('.field-trim-input').checked : false;
                    } else if (type === 'relation') {
                       fieldObj.relation_collection = el.querySelector('.field-relation-collection').value;
                    } else if (type === 'date_only') {
                       fieldObj.date_format = el.querySelector('.field-date-format').value;
                    }
                    fieldsArr.push(fieldObj);
                 });
                 e.detail.parameters.fields = JSON.stringify(fieldsArr);

                 const indexEls = indexesContainer.querySelectorAll('.bg-card');
                 const indexesArr = [];
                 indexEls.forEach(function(el) {
                    indexesArr.push({
                       fields: el.querySelector('.index-fields').value,
                       type: el.querySelector('.index-type').value
                    });
                 });
                 e.detail.parameters.indexes = JSON.stringify(indexesArr);
             }
             
          }
        });

        document.body.addEventListener('htmx:afterRequest', function(e) {
          if (e.target && e.target.id === 'new-collection-form' && e.detail && e.detail.successful) {
            document.getElementById('drawer-container').innerHTML = '';
          }
        });

        // Add 1 default field and initialize section visibility.
        addField();
        const typeSelect = document.querySelector('select[name="type"]');
        if (typeSelect) {
          window.updateNewCollectionType(typeSelect.value);
        }
      })();
    </script>
  `;
  return c.html(formHtml);
});

collections.post("/", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const body = await c.req.parseBody();
  const rawName = (body.name as string) || "";
  const name = rawName.trim().toLowerCase().replace(/\s+/g, "_");
  const type = (body.type as string) || "base";
  const fieldsJson = (body.fields as string) || "[]";
  const indexesJson = (body.indexes as string) || "[]";
  const viewQuery = (body.view_query as string) || null;

  const list_rule = (body.list_rule as string) || null;
  const view_rule = (body.view_rule as string) || null;
  const create_rule = (body.create_rule as string) || null;
  const update_rule = (body.update_rule as string) || null;
  const delete_rule = (body.delete_rule as string) || null;
  const auth_method = (body.auth_method as string) || "email";

  try {
    if (!name || !/^[a-zA-Z0-9_]+$/.test(name))
      throw new Error("Invalid collection name.");
    if (name.startsWith("_"))
      throw new Error(
        "Collection names cannot start with an underscore (reserved for system).",
      );

    if (type === "view") {
      if (!viewQuery)
        throw new Error("View Collection requires a SELECT query.");
      assertReadOnlySqlQuery(viewQuery);
      const query = `CREATE OR REPLACE VIEW "${name}" AS ${viewQuery}`;
      await sql.unsafe(query);

      await sql`
        INSERT INTO _collections 
          (name, type, view_query, list_rule, view_rule, create_rule, update_rule, delete_rule) 
        VALUES 
          (${name}, ${type}, ${viewQuery}, ${list_rule}, ${view_rule}, ${create_rule}, ${update_rule}, ${delete_rule})
      `;
    } else {
      const fields = JSON.parse(fieldsJson).map((f: any) => {
        if (f.name) {
          f.name = f.name.trim().toLowerCase().replace(/\s+/g, "_");
        }
        return f;
      });
      let query = `CREATE TABLE IF NOT EXISTS "${name}" (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()`;

      let finalFields: any[] = [];
      if (type === "base") {
        finalFields.push({
          name: "id",
          type: "text",
          system: true,
          required: false,
        });
        finalFields.push({
          name: "created",
          type: "date",
          system: true,
          required: false,
        });
        finalFields.push({
          name: "updated",
          type: "date",
          system: true,
          required: false,
        });
      }

      let authOptions = {
        google_enabled: body.google_enabled === "true",
        auth_method: body.auth_method || "email",
      };

      if (type === "auth") {
        query += `, "username" VARCHAR(255) UNIQUE${authOptions.auth_method === "username" || authOptions.auth_method === "both" ? " NOT NULL" : ""}, email VARCHAR(255) UNIQUE${authOptions.auth_method === "email" || authOptions.auth_method === "both" ? " NOT NULL" : ""}, verified BOOLEAN NOT NULL DEFAULT FALSE, password_hash VARCHAR(255) NOT NULL, token_key VARCHAR(255) NOT NULL DEFAULT gen_random_uuid()`;

        finalFields.push({
          name: "id",
          type: "text",
          system: true,
          required: false,
        });

        if (authOptions.auth_method === "username") {
          finalFields.push({
            name: "username",
            type: "text",
            system: true,
            required: false,
          });
        } else {
          finalFields.push({
            name: "email",
            type: "email",
            system: true,
            required: false,
          });
        }

        finalFields.push({
          name: "verified",
          type: "boolean",
          system: true,
          required: false,
        });
        finalFields.push({
          name: "password",
          type: "password",
          system: true,
          required: false,
        });
        finalFields.push({
          name: "passwordConfirm",
          type: "password",
          system: true,
          required: false,
        });
        finalFields.push({
          name: "created",
          type: "date",
          system: true,
          required: false,
        });
        finalFields.push({
          name: "updated",
          type: "date",
          system: true,
          required: false,
        });
      }

      const forbiddenNames = [
        "id",
        "created",
        "updated",
        "email",
        "username",
        "password",
        "password_hash",
        "verified",
        "passwordConfirm",
        "created_at",
        "updated_at",
        "token_key",
      ];
      const cleanUserFields = fields.filter(
        (f: any) => !forbiddenNames.includes(f.name.toLowerCase()),
      );

      // Validate that base collections have custom fields
      if (type === "base" && cleanUserFields.length === 0) {
        throw new Error("Base Collection must have at least one custom field.");
      }

      finalFields = [...finalFields, ...cleanUserFields];

      for (const field of cleanUserFields) {
        if (!field.name || !/^[a-zA-Z0-9_]+$/.test(field.name))
          throw new Error(`Invalid field name: ${field.name}`);

        query += `, ${buildFieldColumnDefinition(field)}`;
        for (const check of buildFieldChecks(field, field.name, name)) {
          query += `, CONSTRAINT "${buildSqlConstraintName(name, field.name, check.suffix)}" CHECK (${check.expression})`;
        }
      }
      query += `,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );`;

      await sql.unsafe(query);

      // Create custom indexes and unique constraints
      const customIndexes = JSON.parse(indexesJson);
      for (const idx of customIndexes) {
        if (!idx.fields) continue;
        const columns = idx.fields
          .split(",")
          .map((f: string) => f.trim().toLowerCase().replace(/\s+/g, "_"))
          .filter(Boolean);
        if (columns.length === 0) continue;
        const indexName = `idx_${name}_${columns.join("_")}`;

        if (idx.type === "unique") {
          await sql.unsafe(
            `ALTER TABLE "${name}" ADD CONSTRAINT "uq_${indexName}" UNIQUE ("${columns.join('", "')}")`,
          );
        } else {
          await sql.unsafe(
            `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${name}" ("${columns.join('", "')}")`,
          );
        }
      }
      await sql`
        INSERT INTO _collections 
          (name, type, schema, oauth2, list_rule, view_rule, create_rule, update_rule, delete_rule) 
        VALUES 
          (${name}, ${type}, ${JSON.stringify(finalFields)}::jsonb, ${JSON.stringify(authOptions)}::jsonb, ${list_rule}, ${view_rule}, ${create_rule}, ${update_rule}, ${delete_rule})
      `;
    }

    c.header("HX-Push-Url", `/collections/${name}`);
    return c.html(`
      <script>
        showToast("Collection '${name}' created contextually successfully.", "success");
        setTimeout(() => {
          htmx.ajax('GET', '${collectionsBase}/${name}/records', '#main-content');
          htmx.ajax('GET', '${collectionsBase}', '#collections-list');
        }, 10);
      </script>
    `);
  } catch (err: any) {
    const errMsg =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    c.header(
      "HX-Trigger",
      JSON.stringify({
        "show-toast": {
          message: `Error creating collection: ${errMsg}`,
          type: "error",
        },
      }),
    );
    return c.json({ error: errMsg }, 422);
  }
});

collections.get("/", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const search =
    c.req.query("search") || c.req.query("collection_search") || "";
  const isHtmxRequest =
    c.req.header("HX-Request") === "true" ||
    c.req.header("hx-request") === "true";

  try {
    const tables = await sql`
      SELECT name as table_name, type 
      FROM _collections
      WHERE name NOT LIKE '\\_%'
        ${search ? sql`AND name ILIKE ${"%" + search + "%"}` : sql``}
      ORDER BY name
    `;

    if (!isHtmxRequest) {
      return c.json(tables);
    }

    if (tables.length === 0)
      return c.html(
        `<div class="p-4 text-muted-foreground text-sm">No custom collections found.</div>`,
      );

    return c.html(
      tables
        .map((t) => {
          let typeIcon = `<svg class="w-4 h-4 inline-block align-middle mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
          if (t.type === "auth") {
            typeIcon = `<svg class="w-4 h-4 inline-block align-middle mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20 21a8 8 0 1 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>`;
          } else if (t.type === "view") {
            typeIcon = `<svg class="w-4 h-4 inline-block align-middle mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 3h8l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 3v4h4"/></svg>`;
          }

          const settingsIcon = `<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.02a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.02a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.02a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
          return `
        <div data-collection-item data-collection-name="${t.table_name}" class="group flex items-center justify-between w-full rounded-lg border border-transparent bg-card px-3 py-2 transition-colors hover:bg-muted">
          <button 
            hx-get="${collectionsBase}/${t.table_name}/records" 
            hx-target="#main-content"
            hx-push-url="/collections/${t.table_name}"
            class="flex flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground transition outline-none hover:bg-muted hover:text-foreground"
          >
            <span class="inline-flex items-center">${typeIcon}${t.table_name}</span>
          </button>
          <button hx-get="${collectionsBase}/${t.table_name}/settings" hx-target="#drawer-container" class="rounded-md border border-transparent p-2 text-muted-foreground opacity-0 transition-colors hover:border-border hover:bg-muted hover:text-foreground group-hover:opacity-100" title="Settings">
            ${settingsIcon}
          </button>
        </div>
      `;
        })
        .join(""),
    );
  } catch (err: any) {
    if (!isHtmxRequest) {
      return c.json(
        {
          error:
            process.env.NODE_ENV === "production"
              ? "Internal server error"
              : err.message,
        },
        500,
      );
    }
    console.error("Failed to load collections:", err);
    return c.html(
      `<div class="text-red-500 text-sm">Failed to load collections.</div>`,
      500,
    );
  }
});

collections.get("/api-tester", async (c) => {
  try {
    const collections =
      await sql`SELECT name FROM _collections WHERE type != 'view' ORDER BY name`;
    const collectionOptions = collections
      .map((col: any) => `<option value="${col.name}">${col.name}</option>`)
      .join("");

    return c.html(`
    <div class="max-w-4xl mx-auto rounded-xl border bg-card text-card-foreground shadow-sm p-6 mt-8">
      <div class="mb-6 border-b border-border pb-4">
        <p class="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Tools</p>
        <h2 class="mt-2 text-2xl font-semibold tracking-tight text-foreground">API Tester</h2>
        <p class="mt-2 text-sm text-muted-foreground">Test your public collection endpoints directly from the browser.</p>
      </div>

      <div class="flex gap-4">
        <!-- Request Panel -->
        <div class="w-1/2 space-y-4 pr-4 border-r border-border">
          <div class="space-y-2">
            <label class="block text-sm font-medium text-foreground/80">Collection</label>
            <select id="api-collection" class="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onchange="updateApiUrl()">
              <option value="">-- Select Collection --</option>
              ${collectionOptions}
            </select>
          </div>

          <div class="flex gap-2">
            <select id="api-method" class="flex h-10 w-24 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onchange="updateApiUrl()">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <input type="text" id="api-url" class="flex-1 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="/api/collections/posts/records">
          </div>

          <div>
            <label class="block text-sm font-medium text-foreground/80 mb-1">Headers (JSON)</label>
            <textarea id="api-headers" rows="3" class="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder='{ "Authorization": "Bearer token..." }'></textarea>
          </div>

          <div>
            <label class="block text-sm font-medium text-foreground/80 mb-1">Body (JSON)</label>
            <textarea id="api-body" rows="6" class="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder='{ "key": "value" }'></textarea>
          </div>

          <div class="pt-2 flex justify-end">
            <button onclick="testApi()" class="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
              <span>Send Request</span>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
            </button>
          </div>
        </div>

        <!-- Response Panel -->
        <div class="w-1/2 flex flex-col h-[450px]">
          <div class="flex items-center justify-between mb-2">
            <label class="block text-sm font-medium text-foreground/80">Response</label>
            <div id="api-status" class="text-xs font-mono font-medium px-2 py-1 rounded-md border border-border bg-muted/50 text-muted-foreground">Status: ---</div>
          </div>
          <div class="relative flex-1 overflow-hidden rounded-lg border border-border bg-muted/20">
            <textarea id="api-response" readonly class="absolute inset-0 h-full w-full resize-none bg-transparent p-4 font-mono text-xs text-foreground focus:outline-none" placeholder="Response will appear here..."></textarea>
          </div>
        </div>
      </div>

      <script>
        async function testApi() {
          const method = document.getElementById('api-method').value;
          const url = document.getElementById('api-url').value;
          const headersStr = document.getElementById('api-headers').value;
          const bodyStr = document.getElementById('api-body').value;

          const responseEl = document.getElementById('api-response');
          const statusEl = document.getElementById('api-status');

          responseEl.value = "Loading...";
          statusEl.textContent = "Status: Pending";
          statusEl.className = "text-xs font-mono font-medium px-2 py-1 rounded-md border border-amber-200 bg-amber-50 text-amber-700";

          if (!url) {
            responseEl.value = "Error: URL is required.";
            statusEl.textContent = "Status: Error";
            statusEl.className = "text-xs font-mono font-medium px-2 py-1 rounded-md border border-red-200 bg-red-50 text-red-700";
            return;
          }

          let headers = {};
          try {
            if (headersStr.trim()) headers = JSON.parse(headersStr);
          } catch (e) {
            responseEl.value = "Error parsing Headers JSON: " + e.message;
            statusEl.textContent = "Status: Invalid Headers";
            statusEl.className = "text-xs font-mono font-medium px-2 py-1 rounded-md border border-red-200 bg-red-50 text-red-700";
            return;
          }

          let body = undefined;
          if (["POST", "PATCH", "PUT"].includes(method)) {
            try {
              if (bodyStr.trim()) body = JSON.stringify(JSON.parse(bodyStr));
              headers["Content-Type"] = "application/json";
            } catch (e) {
              responseEl.value = "Error parsing Body JSON: " + e.message;
              statusEl.textContent = "Status: Invalid Body";
              statusEl.className = "text-xs font-mono font-medium px-2 py-1 rounded-md border border-red-200 bg-red-50 text-red-700";
              return;
            }
          }

          try {
            const start = performance.now();
            const res = await fetch(url, {
              method,
              headers,
              body,
            });
            const time = Math.round(performance.now() - start);

            const isOk = res.ok;
            statusEl.textContent = 'Status: ' + res.status + ' ' + res.statusText + ' (' + time + 'ms)';
            statusEl.className = 'text-xs font-mono font-medium px-2 py-1 rounded-md border ' + (isOk ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700');

            const contentType = res.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              const data = await res.json();
              responseEl.value = JSON.stringify(data, null, 2);
            } else {
              const text = await res.text();
              responseEl.value = text;
            }
          } catch (e) {
            responseEl.value = "Network Error: " + e.message;
            statusEl.textContent = "Status: Network Error";
            statusEl.className = "text-xs font-mono font-medium px-2 py-1 rounded-md border border-red-200 bg-red-50 text-red-700";
          }
        }

        function updateApiUrl() {
          const collection = document.getElementById('api-collection').value;
          const method = document.getElementById('api-method').value;
          const urlEl = document.getElementById('api-url');
          
          if (!collection) {
            urlEl.placeholder = '/api/collections/[collection]/records';
            urlEl.value = '';
            return;
          }

          let url = '/api/collections/' + collection;
          if (method === 'GET') {
            url += '/records';
          } else if (method === 'POST') {
            url += '/records';
          }
          urlEl.value = url;
        }
      </script>
    </div>
    `);
  } catch (err) {
    return c.html(
      `<div class="text-red-500 p-4">Error loading collections</div>`,
      500,
    );
  }
});

collections.get("/sql-explorer", (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  return c.html(`
    <div class="max-w-5xl mx-auto rounded-2xl border border-border bg-card text-card-foreground shadow-sm p-6 mt-8">
      <div class="mb-6 border-b border-border pb-4">
        <p class="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Tools</p>
        <h2 class="mt-2 text-2xl font-semibold tracking-tight text-foreground">SQL Explorer</h2>
        <p class="mt-2 text-sm text-muted-foreground">Execute raw SQL queries directly against the Postgres database. Be careful, this can modify or delete data!</p>
      </div>

      <form hx-post="${collectionsBase}/sql-explorer" hx-target="#sql-results" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-foreground/80 mb-1">SQL Query</label>
          <textarea name="query" rows="5" class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="SELECT * FROM current_catalog;"></textarea>
        </div>
        
        <div class="flex justify-end">
          <button type="submit" class="inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
            <span>Execute Query</span>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
          </button>
        </div>
      </form>

      <div class="mt-8">
        <h3 class="border-b border-border pb-2 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">Results</h3>
        <div id="sql-results" class="min-h-[200px] overflow-x-auto rounded-lg border border-border bg-muted/20">
          <div class="p-8 text-center text-sm text-muted-foreground">Query results will appear here...</div>
        </div>
      </div>
    </div>
  `);
});

collections.post("/sql-explorer", async (c) => {
  const body = await c.req.parseBody();
  const query = body.query as string;

  if (!query || query.trim() === "") {
    return c.html(
      `<div class="p-4 text-red-500 bg-red-50">Query cannot be empty.</div>`,
      400,
    );
  }

  try {
    assertReadOnlySqlQuery(query);
    const start = performance.now();
    const result = await sql.unsafe(query);
    const time = Math.round(performance.now() - start);

    if (!result || result.length === 0) {
      if (result.count !== undefined) {
        return c.html(
          `<div class="p-4 text-green-700 bg-green-50 border-b border-green-200 font-mono text-sm">Query successful. Rows affected: ${result.count}. Execution time: ${time}ms.</div>`,
        );
      }
      return c.html(
        `<div class="p-4 text-muted-foreground bg-muted/50 font-mono text-sm">Query executed successfully but returned no rows. Execution time: ${time}ms.</div>`,
      );
    }

    let columns = Object.keys(result[0]);

    // Reorder columns: id first, user fields in middle, system columns at the end
    const idCol = columns.includes("id") ? ["id"] : [];
    const systemColumns = ["created_at", "updated_at"];
    const userColumns = columns.filter(
      (col) => col !== "id" && !systemColumns.includes(col),
    );
    const orderedSystemColumns = systemColumns.filter((col) =>
      columns.includes(col),
    );
    columns = [...idCol, ...userColumns, ...orderedSystemColumns];

    return c.html(`
      <div class="p-2 bg-muted/50 border-b border-border text-xs text-muted-foreground font-mono flex justify-between">
        <span>Rows returned: ${result.length}</span>
        <span>Execution time: ${time}ms</span>
      </div>
      <table class="min-w-full divide-y divide-border text-sm">
        <thead class="bg-muted/50 text-left text-foreground font-medium">
          <tr>
            ${columns.map((col) => `<th class="px-4 py-3 tracking-wider text-sm whitespace-nowrap">${col}</th>`).join("")}
          </tr>
        </thead>
        <tbody class="divide-y divide-border font-mono text-xs">
          ${result
            .map(
              (row) => `
            <tr class="hover:bg-muted/30 transition-colors">
              ${columns
                .map((col) => {
                  const val = row[col];
                  let displayVal = val;
                  // Handle Date objects
                  if (val instanceof Date) {
                    const dateStr = val.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    });
                    const timeStr = val.toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    });
                    displayVal =
                      '<div class="flex flex-col items-center gap-0.5"><span>' +
                      dateStr +
                      '</span><span class="text-xs text-muted-foreground">' +
                      timeStr +
                      "</span></div>";
                  } else if (val === null) {
                    displayVal =
                      '<span class="text-muted-foreground/70 italic">null</span>';
                  } else if (typeof val === "object") {
                    displayVal = JSON.stringify(val);
                  } else {
                    const strVal = String(val);
                    // Check if it's a datetime field
                    if (
                      (col.endsWith("_at") || col.endsWith("_date")) &&
                      (strVal.includes("T") || strVal.includes(" "))
                    ) {
                      try {
                        const date = new Date(strVal);
                        if (!isNaN(date.getTime())) {
                          const dateStr = date.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          });
                          const timeStr = date.toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                            hour12: true,
                          });
                          displayVal =
                            '<div class="flex flex-col items-center gap-0.5"><span>' +
                            dateStr +
                            '</span><span class="text-xs text-muted-foreground">' +
                            timeStr +
                            "</span></div>";
                        } else {
                          displayVal =
                            strVal.length > 50
                              ? strVal.substring(0, 50) + "..."
                              : strVal;
                        }
                      } catch (e) {
                        displayVal =
                          strVal.length > 50
                            ? strVal.substring(0, 50) + "..."
                            : strVal;
                      }
                    } else {
                      displayVal =
                        strVal.length > 50
                          ? strVal.substring(0, 50) + "..."
                          : strVal;
                    }
                  }
                  return `<td class="px-4 py-3 text-foreground max-w-sm truncate" title="${String(val).replace(/"/g, "&quot;")}">${displayVal}</td>`;
                })
                .join("")}
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    `);
  } catch (err: any) {
    console.error("SQL explorer error:", err);
    return c.html(`
      <div class="p-4 bg-red-50 text-red-700 font-mono text-sm border-b border-red-200">
        <strong class="block mb-1">Execution Error:</strong>
        <div class="whitespace-pre-wrap">Internal server error</div>
      </div>
    `);
  }
});

collections.get("/system-settings", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  let googleOauth = { enabled: false, client_id: "", client_secret: "" };
  const configuredTimeZone = await getConfiguredTimeZone();
  const pgBackupSettings = await getPgBackupSettings();
  const pgBackupFiles = await listPgBackupFiles();
  try {
    const res =
      await sql`SELECT value FROM _settings WHERE key = 'google_oauth' LIMIT 1`;
    if (res.length > 0) {
      googleOauth =
        typeof res[0].value === "string"
          ? JSON.parse(res[0].value)
          : res[0].value;
    }
  } catch (e) {}

  return c.html(`
    <div class="max-w-5xl mx-auto rounded-2xl border border-border bg-card text-card-foreground shadow-sm p-6 mt-8">
      <div class="mb-6 border-b border-border pb-4">
        <p class="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Settings</p>
        <h2 class="mt-2 text-2xl font-semibold tracking-tight text-foreground">System Settings</h2>
        <p class="mt-2 text-sm text-muted-foreground">Export your schema to JSON, or import an existing schema.</p>
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <!-- Export Section -->
        <div class="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h3 class="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">Export Schema</h3>
          <p class="mb-4 text-sm text-muted-foreground">Download a JSON file containing all your collections, schema definitions, and API rules. Useful for migrating to a new instance.</p>
          <a href="${collectionsBase}/export/download" target="_blank" class="inline-flex h-10 w-full items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted">
            <i data-lucide="download" class="w-4 h-4 inline-block align-middle mr-1"></i> Download Schema (JSON)
          </a>
        </div>

        <!-- Import Section -->
        <div class="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h3 class="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">Import Schema</h3>
          <p class="mb-4 text-sm text-muted-foreground">Paste your exported JSON array here to import collections. Tables and Views will be created automatically.</p>
          <form hx-post="${collectionsBase}/import" hx-target="#import-result" class="space-y-4">
            <textarea name="schema_json" rows="6" class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder='[{"name": "users", "type": "auth", "schema": [...]}]'></textarea>
            <button type="submit" class="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
              <i data-lucide="upload" class="w-4 h-4 inline-block align-middle mr-1"></i> Import Schema
            </button>
          </form>
          <div id="import-result" class="mt-4"></div>
        </div>
      </div>

      <div class="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h3 class="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">Google OAuth2</h3>
        <p class="mb-4 text-sm text-muted-foreground">Enable Google login globally, then collections can opt into Google auth individually.</p>

        <form id="google-oauth-settings-form" hx-post="${collectionsBase}/system-settings/google-oauth" hx-target="#google-oauth-settings-result" class="space-y-4 max-w-2xl">
          <label class="flex items-center gap-3 text-sm font-medium text-foreground cursor-pointer">
            <input id="google-oauth-enabled" name="enabled" type="checkbox" value="true" ${googleOauth.enabled ? "checked" : ""} class="h-4 w-4 rounded border-border text-primary focus:ring-primary">
            <span>Enable Google OAuth2 globally</span>
          </label>

          <div id="google-oauth-config" class="space-y-4 ${googleOauth.enabled ? "" : "hidden"}">
            <div>
              <label class="block text-sm font-medium text-foreground/80 mb-1" for="google-oauth-client-id">Client ID</label>
              <input id="google-oauth-client-id" type="text" name="client_id" value="${String(googleOauth.client_id || "").replace(/"/g, "&quot;")}" class="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Google OAuth client ID">
            </div>

            <div>
              <label class="block text-sm font-medium text-foreground/80 mb-1" for="google-oauth-client-secret">Client Secret</label>
              <input id="google-oauth-client-secret" type="password" name="client_secret" value="${String(googleOauth.client_secret || "").replace(/"/g, "&quot;")}" class="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Google OAuth client secret">
            </div>
          </div>

          <div class="flex items-center gap-3">
            <button id="google-oauth-save-btn" type="submit" disabled class="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50">Save Google OAuth</button>
            <span class="text-xs text-muted-foreground">Callback URL: <code class="bg-muted px-1 py-0.5 rounded text-foreground">/api/collections/auth-with-oauth2/google/callback</code></span>
          </div>
          <div id="google-oauth-settings-result" class="text-sm"></div>
        </form>
      </div>

      <div class="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h3 class="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">Timezone</h3>
        <p class="mb-4 text-sm text-muted-foreground">Controls how date, date-only, and datetime fields are shown and parsed in the admin panel.</p>
        <form id="timezone-settings-form" hx-post="${collectionsBase}/system-settings/timezone" hx-target="#timezone-save-result" class="space-y-3 max-w-2xl">
          <label class="block text-sm font-medium text-foreground/80" for="system-timezone-select">Default Timezone</label>
          <div class="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
            <select id="system-timezone-select" name="timezone" data-initial-value="${configuredTimeZone}" class="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
              ${COMMON_TIMEZONES.map((tz) => `<option value="${tz}" ${tz === configuredTimeZone ? "selected" : ""}>${tz}</option>`).join("")}
            </select>
            <button id="timezone-save-btn" type="submit" disabled class="inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50">
              Save Timezone
            </button>
          </div>
          <div id="timezone-save-result" class="text-sm"></div>
        </form>
      </div>

      <div class="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h3 class="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">Scheduled Postgres Backup (pg_dump)</h3>
        <p class="mb-4 text-sm text-muted-foreground">Creates portable <code>.dump</code> backups on schedule and keeps only the latest configured count.</p>

        <form id="pg-backup-settings-form" hx-post="${collectionsBase}/backup/pg/settings" hx-target="#pg-backup-settings-result" class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <label for="pg-backup-enabled" class="inline-flex items-center gap-3 text-sm font-medium text-foreground cursor-pointer">
              <span>Enable schedule</span>
              <span class="relative inline-flex h-6 w-11 items-center">
                <input id="pg-backup-enabled" name="enabled" type="checkbox" value="true" ${pgBackupSettings.enabled ? "checked" : ""} class="peer sr-only" />
                <span class="absolute inset-0 rounded-full bg-muted transition-colors peer-checked:bg-primary"></span>
                <span class="absolute left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5"></span>
              </span>
            </label>

            <button id="pg-backup-save-btn" type="submit" disabled class="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50">Save Backup Settings</button>
          </div>

          <div id="pg-backup-config" class="space-y-4 ${pgBackupSettings.enabled ? "" : "hidden"}">
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
              <div>
                <label class="block text-sm font-medium text-foreground/80 mb-1">Frequency</label>
                <select id="pg-backup-frequency" name="frequency" class="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  ${PG_BACKUP_FREQUENCIES.map((freq) => `<option value="${freq}" ${pgBackupSettings.frequency === freq ? "selected" : ""}>${freq}</option>`).join("")}
                </select>
              </div>

              <div>
                <label class="block text-sm font-medium text-foreground/80 mb-1">Keep last N backups</label>
                <input id="pg-backup-retain-count" type="number" name="retain_count" min="1" max="100" value="${pgBackupSettings.retainCount}" class="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
              </div>
            </div>

            <div class="mt-4 flex items-center gap-3">
              <button hx-post="${collectionsBase}/backup/pg/run" hx-target="#pg-backup-run-result" class="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">Run Backup Now</button>
              <span class="text-xs text-muted-foreground">Last run: ${pgBackupSettings.lastRunAt ? new Date(pgBackupSettings.lastRunAt).toLocaleString() : "never"}</span>
            </div>
            <div id="pg-backup-run-result" class="text-sm mt-2"></div>

            <div class="mt-6 rounded-lg border border-border overflow-hidden">
              <div class="px-4 py-3 bg-muted/30 text-sm font-medium text-muted-foreground">Available pg_dump Backups</div>
              ${
                pgBackupFiles.length === 0
                  ? '<div class="p-4 text-sm text-muted-foreground">No pg_dump backups found yet.</div>'
                  : `<div class="divide-y divide-border">
                      ${pgBackupFiles
                        .map(
                          (file: {
                            name: string;
                            sizeBytes: number;
                            mtimeMs: number;
                          }) => `
                        <div class="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div class="text-sm font-mono text-foreground">${file.name}</div>
                            <div class="text-xs text-muted-foreground">${formatBytes(file.sizeBytes)} • ${new Date(file.mtimeMs).toLocaleString()}</div>
                          </div>
                          <div class="flex items-center gap-2">
                            <a href="${collectionsBase}/backup/pg/download/${encodeURIComponent(file.name)}" class="inline-flex items-center justify-center rounded-md border border-input bg-background hover:bg-accent h-9 px-3 text-sm">Download</a>
                            <button hx-post="${collectionsBase}/backup/pg/restore" hx-vals='{"filename":"${file.name.replace(/"/g, "&quot;")}"}' hx-confirm="Restore this pg_dump backup now? This will overwrite current database objects." hx-target="#pg-backup-restore-result" class="inline-flex items-center justify-center rounded-md bg-amber-600 text-white hover:bg-amber-700 h-9 px-3 text-sm">Restore</button>
                          </div>
                        </div>
                      `,
                        )
                        .join("")}
                    </div>`
              }
            </div>
            <div id="pg-backup-restore-result" class="text-sm mt-2"></div>
          </div>
        </form>

        <div id="pg-backup-settings-result" class="text-sm mt-2"></div>
      </div>

    <script>
      (function initSystemSettingsForms() {
        const googleForm = document.getElementById('google-oauth-settings-form');
        const googleEnabled = document.getElementById('google-oauth-enabled');
        const googleConfig = document.getElementById('google-oauth-config');
        const googleClientId = document.getElementById('google-oauth-client-id');
        const googleClientSecret = document.getElementById('google-oauth-client-secret');
        const googleSaveBtn = document.getElementById('google-oauth-save-btn');

        if (googleForm && googleEnabled && googleConfig && googleClientId && googleClientSecret && googleSaveBtn) {
          const initialGoogleState = {
            enabled: googleEnabled.checked,
            clientId: googleClientId.value,
            clientSecret: googleClientSecret.value,
          };

          const updateGoogleUi = function() {
            googleConfig.classList.toggle('hidden', !googleEnabled.checked);
            const unchanged =
              googleEnabled.checked === initialGoogleState.enabled &&
              googleClientId.value === initialGoogleState.clientId &&
              googleClientSecret.value === initialGoogleState.clientSecret;
            googleSaveBtn.disabled = unchanged;
          };

          googleEnabled.addEventListener('change', updateGoogleUi);
          googleClientId.addEventListener('input', updateGoogleUi);
          googleClientSecret.addEventListener('input', updateGoogleUi);
          updateGoogleUi();
        }

        const timezoneForm = document.getElementById('timezone-settings-form');
        const timezoneSelect = document.getElementById('system-timezone-select');
        const timezoneSaveBtn = document.getElementById('timezone-save-btn');

        if (timezoneForm && timezoneSelect && timezoneSaveBtn) {
          const initialTimezone = timezoneSelect.getAttribute('data-initial-value') || timezoneSelect.value;
          const updateTimezoneButton = function() {
            timezoneSaveBtn.disabled = timezoneSelect.value === initialTimezone;
          };
          timezoneSelect.addEventListener('change', updateTimezoneButton);
          updateTimezoneButton();
        }

        const pgForm = document.getElementById('pg-backup-settings-form');
        const enabledInput = document.getElementById('pg-backup-enabled');
        const frequencyInput = document.getElementById('pg-backup-frequency');
        const retainInput = document.getElementById('pg-backup-retain-count');
        const saveBtn = document.getElementById('pg-backup-save-btn');
        const configPanel = document.getElementById('pg-backup-config');

        if (!pgForm || !enabledInput || !frequencyInput || !retainInput || !saveBtn || !configPanel) return;

        const initialState = {
          enabled: enabledInput.checked,
          frequency: frequencyInput.value,
          retainCount: retainInput.value,
        };

        const updatePgSettingsUi = function() {
          configPanel.classList.toggle('hidden', !enabledInput.checked);
          const unchanged =
            enabledInput.checked === initialState.enabled &&
            frequencyInput.value === initialState.frequency &&
            retainInput.value === initialState.retainCount;
          saveBtn.disabled = unchanged;
        };

        enabledInput.addEventListener('change', updatePgSettingsUi);
        frequencyInput.addEventListener('change', updatePgSettingsUi);
        retainInput.addEventListener('input', updatePgSettingsUi);

        updatePgSettingsUi();
      })();
    </script>

    </div>
  `);
});

collections.post("/system-settings/timezone", async (c) => {
  const body = await c.req.parseBody();
  const requestedTimeZone = safeTimeZone((body.timezone as string) || "");

  try {
    await sql`DELETE FROM _settings WHERE key = 'timezone'`;
    await sql`
      INSERT INTO _settings (key, value)
      VALUES ('timezone', ${JSON.stringify({ timezone: requestedTimeZone })}::jsonb)
    `;

    return c.html(`
      <script>
        showToast("Timezone updated.", "success");
        if (window.htmx && typeof window.htmx.ajax === 'function') {
          window.htmx.ajax('GET', '${getCollectionsBasePath(c)}/system-settings', '#main-content');
        }
      </script>
    `);
  } catch (err: any) {
    console.error("Timezone save error:", err);
    const errMsg = "Internal server error";
    return c.html(
      `<script>showToast(${JSON.stringify("Error saving timezone: " + errMsg)}, "error");</script>`,
    );
  }
});

collections.post("/system-settings/google-oauth", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const body = await c.req.parseBody();

  try {
    const next = {
      enabled: body.enabled === "true",
      client_id: String(body.client_id || "").trim(),
      client_secret: String(body.client_secret || "").trim(),
    };

    await sql`DELETE FROM _settings WHERE key = 'google_oauth'`;
    await sql`
      INSERT INTO _settings (key, value)
      VALUES ('google_oauth', ${JSON.stringify(next)}::jsonb)
    `;

    return c.html(`
      <script>
        showToast("Google OAuth settings saved.", "success");
        if (window.htmx && typeof window.htmx.ajax === 'function') {
          window.htmx.ajax('GET', '${collectionsBase}/system-settings', '#main-content');
        }
      </script>
    `);
  } catch (err: any) {
    console.error("Google OAuth settings save error:", err);
    const errMsg = "Internal server error";
    return c.html(
      `<script>showToast(${JSON.stringify("Failed to save Google OAuth settings: " + errMsg)}, "error");</script>`,
    );
  }
});

collections.post("/backup/pg/settings", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const body = await c.req.parseBody();

  try {
    const current = await getPgBackupSettings();
    const next: PgBackupSettings = {
      ...current,
      enabled: body.enabled === "true",
      frequency: normalizePgBackupFrequency(String(body.frequency || "")),
      retainCount: normalizeRetainCount(body.retain_count),
    };
    await savePgBackupSettings(next);
    await applyPgBackupRetention(next.retainCount);

    return c.html(`
      <script>
        showToast("pg_dump backup settings saved.", "success");
        if (window.htmx && typeof window.htmx.ajax === 'function') {
          window.htmx.ajax('GET', '${collectionsBase}/system-settings', '#main-content');
        }
      </script>
    `);
  } catch (err: any) {
    console.error("Backup settings save error:", err);
    const errMsg = "Internal server error";
    return c.html(
      `<script>showToast(${JSON.stringify("Failed to save pg_dump settings: " + errMsg)}, "error");</script>`,
    );
  }
});

collections.post("/backup/pg/run", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);

  try {
    const result = await runPgDumpBackupOnce("manual");
    return c.html(`
      <script>
        showToast("Backup created: ${result.fileName}", "success");
        if (window.htmx && typeof window.htmx.ajax === 'function') {
          window.htmx.ajax('GET', '${collectionsBase}/system-settings', '#main-content');
        }
      </script>
    `);
  } catch (err: any) {
    console.error("Backup run error:", err);
    const errMsg = "Internal server error";
    return c.html(
      `<script>showToast(${JSON.stringify("Backup failed: " + errMsg)}, "error");</script>`,
    );
  }
});

collections.get("/backup/pg/download/:filename", async (c) => {
  try {
    const safeName = sanitizeBackupFilename(c.req.param("filename"));
    const fullPath = join(PG_BACKUP_DIR, safeName);
    await access(fullPath);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename=\"${safeName}\"`);
    return c.body(await Bun.file(fullPath).arrayBuffer());
  } catch (err: any) {
    return c.text(
      process.env.NODE_ENV === "production"
        ? "Backup file not found"
        : `Backup file not found: ${err.message}`,
      404,
    );
  }
});

collections.post("/backup/pg/restore", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const body = await c.req.parseBody();
  const filename = String(body.filename || "");
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");

  try {
    await restorePgDumpBackup(filename);

    return c.html(`
      <script>
        showToast(${JSON.stringify(`Backup restored from ${escapeHtml(filename)}.`)}, "success");
        setTimeout(() => {
          if (window.htmx && typeof window.htmx.ajax === 'function') {
            window.htmx.ajax('GET', '${collectionsBase}', '#collections-list');
            window.htmx.ajax('GET', '${collectionsBase}/system-settings', '#main-content');
          } else {
            window.location.reload();
          }
        }, 200);
      </script>
    `);
  } catch (err: any) {
    console.error("Backup restore error:", err);
    const errMsg = "Internal server error";
    return c.html(
      `<script>showToast(${JSON.stringify("Restore failed: " + errMsg)}, "error");</script>`,
    );
  }
});

collections.get("/export/download", async (c) => {
  try {
    const records =
      await sql`SELECT name, type, schema, list_rule, view_rule, create_rule, update_rule, delete_rule, view_query FROM _collections`;
    c.header("Content-Type", "application/json");
    c.header(
      "Content-Disposition",
      'attachment; filename="grescale_schema.json"',
    );
    return c.body(JSON.stringify(records, null, 2));
  } catch (err: any) {
    return c.text(
      "Failed to export: " +
        (process.env.NODE_ENV === "production"
          ? "Internal server error"
          : err.message),
      500,
    );
  }
});

collections.post("/import", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const body = await c.req.parseBody();
  const jsonStr = body.schema_json as string;
  if (!jsonStr)
    return c.html(
      `<div class="text-red-500 text-sm">Please provide JSON data.</div>`,
      400,
    );

  let parsed: any[];
  try {
    parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed))
      throw new Error("Root must be an array of collections.");
  } catch (err: any) {
    console.error("Import JSON error:", err);
    return c.html(`<div class="text-red-500 text-sm">Invalid JSON.</div>`, 400);
  }

  const results = [];
  let hasFailures = false;
  for (const col of parsed) {
    try {
      const name = col.name;
      if (!name) throw new Error("Missing collection name");

      const type = col.type || "base";

      const schemaStr =
        typeof col.schema === "string"
          ? col.schema
          : Array.isArray(col.schema)
            ? JSON.stringify(col.schema)
            : "[]";

      const viewQuery = col.view_query || null;

      // Check if exists
      const existing =
        await sql`SELECT id FROM _collections WHERE name = ${name} LIMIT 1`;
      if (existing.length > 0) {
        results.push(
          `<div class="text-yellow-600"><i data-lucide="alert-triangle" class="w-4 h-4 inline-block align-middle text-yellow-500 mr-1"></i> Skipped <strong>${name}</strong> (already exists).</div>`,
        );
        continue;
      }

      if (type === "view") {
        if (!viewQuery) throw new Error("View requires view_query");
        assertReadOnlySqlQuery(viewQuery);
        await sql.unsafe(`CREATE OR REPLACE VIEW "${name}" AS ${viewQuery}`);
        await sql`
          INSERT INTO _collections 
            (name, type, view_query, list_rule, view_rule, create_rule, update_rule, delete_rule) 
          VALUES 
            (${name}, ${type}, ${viewQuery}, ${col.list_rule || null}, ${col.view_rule || null}, ${col.create_rule || null}, ${col.update_rule || null}, ${col.delete_rule || null})
        `;
      } else {
        const fields = JSON.parse(schemaStr);
        let query = `CREATE TABLE IF NOT EXISTS "${name}" (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid()`;

        if (type === "auth") {
          query += `, email VARCHAR(255) UNIQUE, password_hash VARCHAR(255), token_key VARCHAR(255) DEFAULT gen_random_uuid()`;
        }

        for (const field of fields) {
          const safeName = field.name.replace(/[^a-zA-Z0-9_]/g, "");
          if (!safeName) {
            throw new Error(`Invalid field name: ${field.name}`);
          }
          const safeType = field.type.replace(/[^a-zA-Z0-9_\(\)\s]/g, "");
          query += `, "${safeName}" ${safeType}`;
        }
        query += `,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );`;

        await sql.unsafe(query);
        await sql`
          INSERT INTO _collections 
            (name, type, schema, list_rule, view_rule, create_rule, update_rule, delete_rule) 
          VALUES 
            (${name}, ${type}, ${schemaStr}, ${col.list_rule || null}, ${col.view_rule || null}, ${col.create_rule || null}, ${col.update_rule || null}, ${col.delete_rule || null})
        `;
      }

      results.push(
        `<div class="text-green-600 border-b pb-1 mb-1 border-gray-100"><i data-lucide="check-circle-2" class="w-4 h-4 inline-block align-middle text-green-500 mr-1"></i> Imported <strong>${String(name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;")}</strong> successfully.</div>`,
      );
    } catch (e: any) {
      console.error("Collection import error:", e);
      const safeCollectionName = String(name)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
      const safeErrorMessage = String(e.message || "Unknown error")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
      results.push(
        `<div class="text-red-500 border-b pb-1 mb-1 border-gray-100"><i data-lucide="x-circle" class="w-4 h-4 inline-block align-middle text-red-500 mr-1"></i> Failed <strong>${safeCollectionName}</strong>: ${safeErrorMessage}</div>`,
      );
    }
  }

  return c.html(
    `
    <div class="p-3 bg-white border border-border rounded shadow-sm text-sm mt-2 max-h-48 overflow-y-auto font-mono">
      ${results.join("")}
    </div>
    <button hx-get="${collectionsBase}" hx-target="#collections-list" class="mt-4 inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2 w-full">
      <i data-lucide="refresh-cw" class="w-4 h-4 inline-block align-middle mr-1"></i> Refresh Sidebar
    </button>
  `,
    hasFailures ? 422 : 200,
  );
});

collections.get("/logs", async (c) => {
  const isHtmxRequest =
    c.req.header("HX-Request") === "true" ||
    c.req.header("hx-request") === "true";

  try {
    const logs = await sql`
      SELECT id, method, url, status, error, collection, user_ip, user_agent, created_at 
      FROM _logs 
      ORDER BY created_at DESC 
      LIMIT 100
    `;

    // Return JSON for non-HTMX requests
    if (!isHtmxRequest) {
      return c.json({ logs: logs });
    }

    const formattedLogs = logs.map((log: any) => ({
      ...log,
      created_at: new Date(log.created_at).toLocaleString(),
    }));

    const html = await renderTemplate("logs", {
      logs: formattedLogs,
      count: logs.length,
    });
    return c.html(html);
  } catch (err: any) {
    console.error("Logs route error:", err);
    if (!isHtmxRequest) {
      return c.json({ error: "Internal server error" }, 500);
    }
    const html = await renderTemplate("error-message", {
      message: `Logs error: Internal server error`,
    });
    return c.html(html, 500);
  }
});

collections.get("/:collection/records", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  const filter = c.req.query("filter") || c.req.query("record_filter") || "";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const isPartial = c.req.query("partial") === "1";
  const requestedSort = c.req.query("sort") || "";
  const requestedOrder = c.req.query("order") === "asc" ? "asc" : "desc";
  const perPage = 40;
  const offset = (page - 1) * perPage;
  const isHtmxRequest =
    c.req.header("HX-Request") === "true" ||
    c.req.header("hx-request") === "true";

  try {
    const configuredTimeZone = await getConfiguredTimeZone();
    const meta =
      await sql`SELECT type, schema FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    const isView = meta.length > 0 && meta[0].type === "view";

    const columnInfo = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = ${collectionName}
        AND table_schema = 'public'
    `;
    const availableSortColumns = columnInfo.map((col: any) => col.column_name);
    const defaultSortColumn = availableSortColumns.includes("created_at")
      ? "created_at"
      : availableSortColumns.includes("id")
        ? "id"
        : availableSortColumns[0] || "id";
    const sortColumn = availableSortColumns.includes(requestedSort)
      ? requestedSort
      : defaultSortColumn;
    const sortDirection = requestedSort ? requestedOrder : "desc";
    const sortQuery = `sort=${encodeURIComponent(sortColumn)}&order=${sortDirection}`;
    const allowedColumns = availableSortColumns;

    const centeredColumns = new Set<string>();
    const numericDataTypes = new Set([
      "smallint",
      "integer",
      "bigint",
      "decimal",
      "numeric",
      "real",
      "double precision",
    ]);

    for (const col of columnInfo as any[]) {
      const dataType = String(col.data_type || "").toLowerCase();
      if (
        dataType === "date" ||
        dataType.includes("time") ||
        numericDataTypes.has(dataType)
      ) {
        centeredColumns.add(col.column_name);
      }
    }

    if (meta.length > 0 && meta[0].schema) {
      try {
        const parsedSchema =
          typeof meta[0].schema === "string"
            ? JSON.parse(meta[0].schema)
            : meta[0].schema;
        if (Array.isArray(parsedSchema)) {
          for (const field of parsedSchema) {
            if (
              field &&
              typeof field.name === "string" &&
              (field.type === "date_only" || field.type === "number")
            ) {
              centeredColumns.add(field.name);
            }
          }
        }
      } catch {
        // Ignore schema parse errors and fall back to DB type-based alignment.
      }
    }

    let records: any[];
    let totalItems = 0;
    if (filter) {
      try {
        const sqlFilterStr = buildSafeSqlFilter(filter, allowedColumns);
        const rows = await sql.unsafe(
          `SELECT * FROM ${quoteIdentifier(collectionName)} WHERE ${sqlFilterStr} ORDER BY "${sortColumn}" ${sortDirection.toUpperCase()} LIMIT ${perPage} OFFSET ${offset}`,
        );
        const countRes = await sql.unsafe(
          `SELECT count(*) as count FROM ${quoteIdentifier(collectionName)} WHERE ${sqlFilterStr}`,
        );
        records = rows;
        totalItems = parseInt(countRes[0].count, 10);
      } catch (e) {
        return c.html(
          `<div class="text-red-500">Invalid filter syntax.</div>`,
          400,
        );
      }
    } else {
      records = await sql.unsafe(
        `SELECT * FROM ${quoteIdentifier(collectionName)} ORDER BY "${sortColumn}" ${sortDirection.toUpperCase()} LIMIT ${perPage} OFFSET ${offset}`,
      );
      const countRes =
        await sql`SELECT count(*) as count FROM ${sql(collectionName)}`;
      totalItems = parseInt(countRes[0].count, 10);
    }

    // Sanitize records to prevent displaying passwords
    const sanitizedRecords = records.map((r: any) => {
      const clean = { ...r };
      delete clean.password;
      delete clean.password_hash;
      return clean;
    });

    // Reorder columns: id first, user fields in middle, system columns at the end
    let columns: string[] = [];
    if (sanitizedRecords.length > 0) {
      const allColumns = Object.keys(sanitizedRecords[0]);
      const idCol = allColumns.includes("id") ? ["id"] : [];
      const systemColumns = ["created_at", "updated_at"];
      const userColumns = allColumns.filter((col) => {
        if (col === "id" || systemColumns.includes(col)) return false;
        if (collectionName === "_users" && col === "owner") return false;
        return true;
      });
      const orderedSystemColumns = systemColumns.filter((col) =>
        allColumns.includes(col),
      );
      columns = [...idCol, ...userColumns, ...orderedSystemColumns];
    }

    const hasMore = page * perPage < totalItems;
    const nextPage = page + 1;
    const loadMoreUrl = `${collectionsBase}/${collectionName}/records?page=${nextPage}&partial=1&${sortQuery}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`;

    const formatCellValue = (val: any, colName: string) => {
      if (val === null) {
        return '<span class="text-muted-foreground/70 italic">null</span>';
      }

      const escapeHtml = (value: string) =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");

      const stripHtml = (value: string) => value.replace(/<[^>]*>/g, "");

      // Handle Date objects
      if (val instanceof Date) {
        const dateStr = val.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: configuredTimeZone,
        });
        const timeStr = val.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: configuredTimeZone,
        });
        return `<div class="flex flex-col items-center gap-0.5"><span>${dateStr}</span><span class="text-xs text-muted-foreground">${timeStr}</span></div>`;
      }
      if (typeof val === "object") {
        const jsonText = JSON.stringify(val);
        const clippedJson =
          jsonText.length > 50 ? `${jsonText.substring(0, 50)}...` : jsonText;
        return `<span class="block min-w-0 truncate">${escapeHtml(clippedJson)}</span>`;
      }
      const strVal = String(val);
      // Check if it's a datetime field (created_at, updated_at, or ends with _at)
      if (
        (colName.endsWith("_at") || colName.endsWith("_date")) &&
        (strVal.includes("T") || strVal.includes(" "))
      ) {
        try {
          const date = new Date(strVal);
          if (!isNaN(date.getTime())) {
            const dateStr = date.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              timeZone: configuredTimeZone,
            });
            const timeStr = date.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
              timeZone: configuredTimeZone,
            });
            return `<div class="flex flex-col items-center gap-0.5"><span>${dateStr}</span><span class="text-xs text-muted-foreground">${timeStr}</span></div>`;
          }
        } catch (e) {
          // Fall through to normal formatting
        }
      }

      const previewText = stripHtml(strVal);
      const clippedText =
        previewText.length > 50
          ? `${previewText.substring(0, 50)}...`
          : previewText;
      return `<span class="block min-w-0 truncate">${escapeHtml(clippedText)}</span>`;
    };

    const rowsHtml = sanitizedRecords
      .map(
        (record) => `
      <tr class="hover:bg-muted/50 cursor-pointer" data-collection-name="${String(collectionName).replace(/"/g, "&quot;")}" data-record-id="${String(record.id).replace(/"/g, "&quot;")}" tabindex="0" role="button" aria-label="Edit record ${String(record.id).replace(/"/g, "&quot;")}">
        ${columns
          .map((col) => {
            const val = record[col];
            const displayVal = formatCellValue(val, col);
            if (col === "id") {
              const fullId = String(val);
              let shortId;
              if (fullId.includes("-")) {
                shortId = fullId.split("-")[0] + "...";
              } else if (fullId.length > 6) {
                shortId = fullId.substring(0, 6) + "...";
              } else {
                shortId = fullId;
              }
              return `<td class="px-6 py-4 whitespace-nowrap text-foreground max-w-[18rem] overflow-hidden">
                <button
                  type="button"
                  class="block w-full min-w-0 text-left font-mono cursor-copy"
                  title="Click to copy ID"
                  onclick='copyCollectionId(event, ${JSON.stringify(fullId)})'
                >${shortId}</button>
              </td>`;
            }
            if (collectionName === "_users" && col === "email") {
              const ownerBadge =
                record.owner === true
                  ? `<span class="ml-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Owner</span>`
                  : "";
              return `<td class="px-6 py-4 whitespace-nowrap text-foreground max-w-[24rem] overflow-hidden text-left"><div class="flex items-center gap-2 min-w-0">${displayVal}${ownerBadge}</div></td>`;
            }
            const tdAlignClass = centeredColumns.has(col)
              ? "text-center"
              : "text-left";
            return `<td class="px-6 py-4 whitespace-nowrap text-foreground max-w-[24rem] overflow-hidden ${tdAlignClass}">${displayVal}</td>`;
          })
          .join("")}
      </tr>
    `,
      )
      .join("");

    if (isPartial) {
      return c.html(`
        <tbody id="records-table-body" hx-swap-oob="beforeend">
          ${rowsHtml}
        </tbody>
        <div id="records-pagination" hx-swap-oob="outerHTML">
          ${
            hasMore
              ? `<button
              class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4"
              hx-get="${loadMoreUrl}"
              hx-target="#records-pagination"
              hx-swap="outerHTML"
            >
              Load more
            </button>`
              : ""
          }
        </div>
      `);
    }

    const contentHtml = `
      <div class="h-full min-h-0 flex flex-col">
      <div class="mb-3 shrink-0">
        <div>
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-2">
            <h2 class="text-xl text-foreground">Collections / ${collectionName} ${isView ? '<span class="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded ml-2 align-middle">VIEW</span>' : ""}</h2>
            ${
              collectionName === "_users"
                ? ""
                : `<button hx-get="${collectionsBase}/${collectionName}/settings" hx-target="#drawer-container" class="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" title="Settings" aria-label="Settings">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0 lucide lucide-settings-icon lucide-settings"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle></svg>
              </button>`
            }
          </div>

            <div class="flex items-center gap-2">
              ${
                isView
                  ? ""
                  : `<button hx-get="${collectionsBase}/${collectionName}/new-record" hx-target="#drawer-container" class="inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium leading-none ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90">
                <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v14M5 12h14"/></svg>
                <span>New Record</span>
              </button>`
              }
            </div>
          </div>
          <div class="mt-2">
            <input 
              type="search" 
              name="filter"
              value="${filter.replace(/"/g, "&quot;")}"
              placeholder="Search like title = &quot;Title 1&quot;..."
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              oninput="syncCollectionFilterUrl('${collectionName}', this.value)"
              hx-get="${collectionsBase}/${collectionName}/records?${sortQuery}"
              hx-target="#records-content"
              hx-select="#records-content"
              hx-swap="outerHTML"
              hx-trigger="keyup changed delay:400ms, search"
              hx-push-url="false"
            />
          </div>
        </div>
      </div>
      <div id="records-content" class="flex-1 min-h-0 flex flex-col">
      <div class="rounded-2xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden flex-1 min-h-0 flex flex-col">
        ${
          totalItems === 0
            ? '<div class="p-8 text-center text-muted-foreground">No records found.</div>'
            : `<div class="flex-1 min-h-0 overflow-auto">
              <table class="min-w-full divide-y divide-border text-sm">
                <thead class="bg-muted/30 text-left font-medium text-muted-foreground">
                  <tr>
                    ${columns
                      .map((key) => {
                        const isCenteredColumn = centeredColumns.has(key);
                        const isActiveSort = key === sortColumn;
                        const nextOrder =
                          isActiveSort && sortDirection === "asc"
                            ? "desc"
                            : "asc";
                        const sortApiUrl = `${collectionsBase}/${collectionName}/records?page=1&partial=0&sort=${encodeURIComponent(key)}&order=${nextOrder}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`;
                        const sortPageUrl = `/collections/${encodeURIComponent(collectionName)}?page=1&sort=${encodeURIComponent(key)}&order=${nextOrder}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`;
                        const sortArrow = isActiveSort
                          ? sortDirection === "asc"
                            ? '<i data-lucide="arrow-up" class="w-3 h-3"></i>'
                            : '<i data-lucide="arrow-down" class="w-3 h-3"></i>'
                          : '<i data-lucide="arrow-up-down" class="w-3 h-3"></i>';
                        const thAlignClass = isCenteredColumn
                          ? "text-center"
                          : "text-left";
                        const buttonAlignClass = isCenteredColumn
                          ? "inline-flex items-center justify-center gap-1 hover:text-foreground transition-colors w-full"
                          : "inline-flex items-center gap-1 hover:text-foreground transition-colors";
                        return `<th class="px-6 py-3 tracking-wider whitespace-nowrap ${thAlignClass}"><button type="button" class="${buttonAlignClass}" hx-get="${sortApiUrl}" hx-target="#main-content" hx-push-url="${sortPageUrl}"><span>${key}</span><span class="inline-flex items-center justify-center text-[10px] leading-none opacity-70">${sortArrow}</span></button></th>`;
                      })
                      .join("")}
                  </tr>
                </thead>
                <tbody id="records-table-body" class="divide-y divide-border bg-card">
                  ${rowsHtml}
                </tbody>
              </table>
            </div>`
        }
      </div>
      <div class="mt-3 shrink-0">
        <div class="text-xs text-muted-foreground text-left w-full">Total found: ${totalItems}</div>
        <div id="records-pagination" class="mt-2 flex justify-end">
          ${
            hasMore
              ? `<button
              class="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              hx-get="${loadMoreUrl}"
              hx-target="#records-pagination"
              hx-swap="outerHTML"
            >
              Load more
            </button>`
              : ""
          }
        </div>
      </div>
      </div>
      </div>
      <script>
        window.collectionRecordsUrl = ${JSON.stringify(`${collectionsBase}/${collectionName}/records?${sortQuery}${filter ? `&filter=${encodeURIComponent(filter)}` : ""}`)};

        window.openCollectionRecordEditor = async function(collectionName, recordId) {
          try {
            const response = await fetch('${collectionsBase}/' + collectionName + '/records/' + recordId + '/edit', {
              headers: {
                'HX-Request': 'true',
              },
            });
            const html = await response.text();

            if (!response.ok) {
              const tmp = document.createElement('div');
              tmp.innerHTML = html;
              const message = (tmp.textContent || '').trim() || 'Unable to open record.';
              if (window.showToast) window.showToast(message, 'error');
              return;
            }

            const drawerContainer = document.getElementById('drawer-container');
            if (!drawerContainer) return;
            drawerContainer.innerHTML = html;

            // Drawer HTML is injected via fetch, so initialize HTMX on new nodes.
            if (window.htmx && typeof window.htmx.process === 'function') {
              window.htmx.process(drawerContainer);
            }

            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set('recordId', String(recordId));
            window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
          } catch (error) {
            console.error('Failed to open record editor:', error);
            if (window.showToast) window.showToast('Failed to open record editor.', 'error');
          }
        };

        const syncRecordIdParamOnDrawerClose = function() {
          const drawerContainer = document.getElementById('drawer-container');
          if (!drawerContainer || drawerContainer.dataset.recordIdObserverBound === '1') return;
          drawerContainer.dataset.recordIdObserverBound = '1';

          const observer = new MutationObserver(function() {
            if (drawerContainer.children.length > 0) return;
            const currentUrl = new URL(window.location.href);
            if (!currentUrl.searchParams.has('recordId')) return;
            currentUrl.searchParams.delete('recordId');
            window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
          });

          observer.observe(drawerContainer, {
            childList: true,
          });
        };

        const bindRecordRowHandlers = function() {
          if (window.__recordRowHandlersBound) return;
          window.__recordRowHandlersBound = true;

          document.body.addEventListener('click', function(event) {
            const rawTarget = event.target;
            const target = rawTarget instanceof Element ? rawTarget : rawTarget && rawTarget.parentElement;
            if (!(target instanceof Element)) return;

            if (target.closest('button, a, input, textarea, select, label')) {
              return;
            }

            const row = target.closest('tr[data-record-id]');
            if (!row) return;

            const recordId = row.getAttribute('data-record-id');
            const rowCollectionName = row.getAttribute('data-collection-name') || ${JSON.stringify(collectionName)};
            if (!recordId) return;
            window.openCollectionRecordEditor(rowCollectionName, recordId);
          });

          document.body.addEventListener('keydown', function(event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const rawTarget = event.target;
            const target = rawTarget instanceof Element ? rawTarget : rawTarget && rawTarget.parentElement;
            if (!(target instanceof Element)) return;
            const row = target.closest('tr[data-record-id]');
            if (!row) return;
            event.preventDefault();

            const recordId = row.getAttribute('data-record-id');
            const rowCollectionName = row.getAttribute('data-collection-name') || ${JSON.stringify(collectionName)};
            if (!recordId) return;
            window.openCollectionRecordEditor(rowCollectionName, recordId);
          });
        };

        bindRecordRowHandlers();
        syncRecordIdParamOnDrawerClose();

        (function openRecordFromUrlParam() {
          const params = new URLSearchParams(window.location.search);
          const recordId = params.get('recordId');
          if (!recordId) return;
          window.openCollectionRecordEditor(${JSON.stringify(collectionName)}, recordId);
        })();

        window.copyCollectionId = async function(event, id) {
          event.preventDefault();
          event.stopPropagation();
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(id);
            } else {
              const textarea = document.createElement('textarea');
              textarea.value = id;
              textarea.style.position = 'fixed';
              textarea.style.opacity = '0';
              document.body.appendChild(textarea);
              textarea.focus();
              textarea.select();
              const copied = document.execCommand('copy');
              document.body.removeChild(textarea);
              if (!copied) {
                throw new Error('Clipboard copy failed');
              }
            }
            if (typeof window.showToast === 'function') {
              window.showToast('Copied to clipboard', 'success');
            }
          } catch (e) {
            console.error('Failed to copy collection ID:', e);
            if (typeof window.showToast === 'function') {
              window.showToast('Failed to copy to clipboard', 'error');
            }
          }
        };
      </script>
    `;

    return c.html(contentHtml);
  } catch (err: any) {
    console.error("Collection page error:", err);
    return c.html(
      `<div class="text-red-500 p-4 bg-red-50 rounded border border-red-200">Collection error: Internal server error</div>`,
      500,
    );
  }
});

collections.get("/:collection/new-record", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  try {
    const meta =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length > 0 && meta[0].type === "view") {
      return c.html(
        `<div class="text-red-500 p-4">Views are read only.</div>`,
        405,
      );
    }

    const isAuthCollection = meta.length > 0 && meta[0].type === "auth";
    const currentAdminRecord = isSystemUsers
      ? await getCurrentAdminRecord(c)
      : null;
    const canManageOwnership = currentAdminRecord?.owner === true;
    let authMethod = "email";
    if (isAuthCollection && meta[0].oauth2) {
      try {
        const oauthCfg =
          typeof meta[0].oauth2 === "string"
            ? JSON.parse(meta[0].oauth2)
            : meta[0].oauth2;
        authMethod = oauthCfg?.auth_method || "email";
      } catch (e) {}
    }

    const columns = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = ${collectionName} 
        AND table_schema = 'public'
        AND column_name NOT IN ('id', 'created', 'updated', 'created_at', 'updated_at', 'password_hash', 'token_key', 'verified', 'password', 'passwordconfirm', 'owner')
    `;

    // Parse schema JSON to get rich field types
    let definedSchema: { name: string; type: string }[] = [];
    try {
      if (meta.length > 0 && meta[0].schema) {
        definedSchema =
          typeof meta[0].schema === "string"
            ? JSON.parse(meta[0].schema)
            : meta[0].schema;
      }
    } catch (e) {}

    const nonAuthColumns = isSystemUsers
      ? columns.filter((col) => col.column_name !== "email")
      : isAuthCollection
        ? columns.filter(
            (col) =>
              !["username", "email", "verified"].includes(col.column_name),
          )
        : columns;

    const authFieldsHtml = isSystemUsers
      ? `
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">email <span class="text-xs text-muted-foreground/70">(required)</span></label>
          <input type="email" name="email" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">password <span class="text-xs text-muted-foreground/70">(min 8 chars)</span></label>
          <input type="password" name="password" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">passwordConfirm</label>
          <input type="password" name="passwordConfirm" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
        </div>
      `
      : isAuthCollection
        ? `
        ${
          authMethod === "username" || authMethod === "both"
            ? `<div>
          <label class="block text-sm font-medium text-foreground mb-1">username <span class="text-xs text-muted-foreground/70">(required)</span></label>
          <input type="text" name="username" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
        </div>`
            : ""
        }
        ${
          authMethod === "email" || authMethod === "both"
            ? `<div>
          <label class="block text-sm font-medium text-foreground mb-1">email <span class="text-xs text-muted-foreground/70">(required)</span></label>
          <input type="email" name="email" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
        </div>`
            : ""
        }
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">verified</label>
          <label class="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" name="verified" value="true" class="h-4 w-4 rounded border-input">
            <span>Mark as verified</span>
          </label>
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">password <span class="text-xs text-muted-foreground/70">(min 8 chars)</span></label>
          <input type="password" name="password" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">passwordConfirm</label>
          <input type="password" name="passwordConfirm" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
        </div>
      `
        : "";

    const fieldsHtml = nonAuthColumns
      .map((col) => {
        // Find the logical type from the schema mapping
        const logicalField = definedSchema.find(
          (f) => f.name === col.column_name,
        );
        const logicalType = logicalField
          ? logicalField.type.toLowerCase()
          : col.data_type;

        if (logicalType === "richtext") {
          // Rich text editor block using basic textarea + a small UI hint (can be upgraded to Quill or Trix later)
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name} <span class="text-xs text-muted-foreground/70">(RichText)</span></label>
            <div class="border rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
              <div class="bg-muted p-2 flex gap-2 border-b">
                 <button type="button" class="px-2 py-1 text-xs bg-background border rounded hover:bg-accent" onclick="document.getElementById('rt_${col.column_name}').value += '<b>bold</b>'">B</button>
                 <button type="button" class="px-2 py-1 text-xs bg-background border rounded hover:bg-accent" onclick="document.getElementById('rt_${col.column_name}').value += '<i>italic</i>'">I</button>
              </div>
              <textarea id="rt_${col.column_name}" name="${col.column_name}" rows="6" class="w-full flex border-0 bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50" placeholder="Write rich text HTML here..."></textarea>
            </div>
          </div>
        `;
        }

        if (logicalType === "geolocation") {
          return `
          <div>
             <label class="block text-sm font-medium text-foreground mb-1">${col.column_name} <span class="text-xs text-muted-foreground/70">(Geolocation JSON)</span></label>
             <div class="flex gap-4">
               <input type="number" step="any" name="${col.column_name}_lat" placeholder="Latitude (e.g. 40.71)" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
               <input type="number" step="any" name="${col.column_name}_lon" placeholder="Longitude (e.g. -74.00)" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
             </div>
             <p class="text-xs text-muted-foreground mt-1">Saved automatically as <code>{"lat": x, "lon": y}</code></p>
          </div>
        `;
        }

        let inputType = "text";
        if (logicalType === "date_only" || col.data_type === "date") {
          inputType = "date";
        } else if (col.data_type.includes("timestamp"))
          inputType = "datetime-local";
        else if (
          col.data_type.includes("int") ||
          col.data_type.includes("numeric")
        )
          inputType = "number";
        else if (col.data_type === "boolean") inputType = "checkbox";

        return `
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">${col.column_name} <span class="text-xs text-muted-foreground/70">(${col.data_type})</span></label>
          ${
            inputType === "text" &&
            (col.data_type === "text" || col.data_type === "jsonb")
              ? `<textarea name="${col.column_name}" rows="3" class="w-full flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"></textarea>`
              : `<input type="${inputType}" name="${col.column_name}" ${inputType === "checkbox" ? 'value="true"' : ""} class="w-full flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">`
          }
        </div>
      `;
      })
      .join("");

    return c.html(`
      <div data-drawer-backdrop class="fixed inset-0 z-50 bg-black/50 flex justify-end transition-opacity" onclick="if(event.target===this) window.closeDrawer()">
        <div data-drawer-panel class="w-full max-w-md bg-background shadow-xl h-full flex flex-col border-l border-border transform translate-x-0" onclick="event.stopPropagation()">
          <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/20">
            <h2 class="text-xl font-bold text-foreground">New Record: <span class="capitalize text-primary">${collectionName}</span></h2>
            <button type="button" onclick="window.closeDrawer()" class="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground">
              <svg class="w-5 h-5 block" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
          <form method="post" action="${collectionsBase}/${collectionName}/records" hx-post="${collectionsBase}/${collectionName}/records" hx-target="#main-content" class="flex flex-col h-full overflow-hidden" hx-on::after-request="if (event.detail.successful) window.closeDrawer()">
            <div class="flex-1 overflow-y-auto p-6 space-y-6">
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">id <span class="text-xs text-muted-foreground/70">(optional UUID, auto-generated if blank)</span></label>
                <input type="text" name="id" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Leave blank to auto-generate">
              </div>
              ${authFieldsHtml}
              ${fieldsHtml}
            </div>
            
            <div class="p-4 border-t border-border bg-muted/10 flex justify-end gap-3">
              <button type="button" onclick="window.closeDrawer()" class="px-4 py-2 hover:bg-muted rounded-md text-sm font-medium transition">Cancel</button>
              <button type="submit" class="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-2 rounded-md text-sm font-medium transition shadow-sm">Save Record</button>
            </div>
          </form>
        </div>
      </div>
    `);
  } catch (err: any) {
    console.error("Load form error:", err);
    return c.html(
      `<div class="text-red-500 p-4">Error loading form: Internal server error</div>`,
      500,
    );
  }
});

collections.get("/:collection/records/:id/edit", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  const recordId = c.req.param("id");

  try {
    const metaRows =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    const isSystemUsers = collectionName === "_users";
    if (metaRows.length === 0 && !isSystemUsers) {
      return c.html(
        `<div class="text-red-500 p-4">Collection not found.</div>`,
        404,
      );
    }
    const meta =
      metaRows.length > 0
        ? metaRows
        : [{ type: "base", schema: null, oauth2: null }];
    if (meta[0].type === "view") {
      return c.html(
        `<div class="text-red-500 p-4">Views are read only.</div>`,
        405,
      );
    }

    const recordRes = await sql`
      SELECT * FROM ${sql(collectionName)} WHERE id = ${recordId} LIMIT 1
    `;
    if (recordRes.length === 0) {
      return c.html(
        `<div class="text-red-500 p-4">Record not found.</div>`,
        404,
      );
    }

    const record = recordRes[0];
    const configuredTimeZone = await getConfiguredTimeZone();
    const isAuthCollection = meta[0].type === "auth";
    let authMethod = "email";
    if (isAuthCollection && meta[0].oauth2) {
      try {
        const oauthCfg =
          typeof meta[0].oauth2 === "string"
            ? JSON.parse(meta[0].oauth2)
            : meta[0].oauth2;
        authMethod = oauthCfg?.auth_method || "email";
      } catch (e) {}
    }

    const columns = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = ${collectionName} 
        AND table_schema = 'public'
        AND column_name NOT IN ('id', 'created', 'updated', 'created_at', 'updated_at', 'password_hash', 'token_key', 'verified', 'password', 'passwordconfirm')
    `;

    let definedSchema: { name: string; type: string; date_format?: string }[] =
      [];
    try {
      if (meta.length > 0 && meta[0].schema) {
        definedSchema =
          typeof meta[0].schema === "string"
            ? JSON.parse(meta[0].schema)
            : meta[0].schema;
      }
    } catch (e) {}

    const escapeHtml = (value: any) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const formatDateOnly = (value: any) =>
      formatDateOnlyForInput(value, configuredTimeZone);

    const formatDateTimeLocal = (value: any) =>
      formatDateTimeForInput(value, configuredTimeZone);

    const renderBooleanSelect = (name: string, checked: boolean) => `
      <select name="${name}" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <option value="true" ${checked ? "selected" : ""}>Yes</option>
        <option value="false" ${!checked ? "selected" : ""}>No</option>
      </select>
    `;

    const editFieldSnapshotEntries: [string, string][] = [];
    const addEditSnapshot = (name: string, value: any) => {
      editFieldSnapshotEntries.push([name, String(value ?? "")]);
    };

    const currentAdminRecord = isSystemUsers
      ? await getCurrentAdminRecord(c)
      : null;
    const canManageOwnership = currentAdminRecord?.owner === true;
    const canEditOwnPassword =
      isSystemUsers && currentAdminRecord?.id === record.id;
    const canEditAnySuperadminPassword =
      isSystemUsers && currentAdminRecord?.owner === true;
    const isCurrentOwner = isSystemUsers && record.owner === true;
    const canTransferOwnership =
      isSystemUsers && canManageOwnership && !isCurrentOwner;

    const nonAuthColumns = isSystemUsers
      ? columns.filter(
          (col) =>
            !["username", "email", "verified", "owner"].includes(
              col.column_name,
            ),
        )
      : isAuthCollection
        ? columns.filter(
            (col) =>
              !["username", "email", "verified"].includes(col.column_name),
          )
        : columns;

    const authFieldsHtml = isSystemUsers
      ? `
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">email <span class="text-xs text-muted-foreground/70">(required)</span></label>
          <div class="flex flex-wrap items-center gap-2">
            <input type="email" name="email" value="${escapeHtml(record.email || "")}" class="min-w-0 flex-1 h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          </div>
        </div>
        ${
          canEditOwnPassword || canEditAnySuperadminPassword
            ? `<div>
          <label class="block text-sm font-medium text-foreground mb-1">password <span class="text-xs text-muted-foreground/70">(leave blank to keep current)</span></label>
          <input type="password" name="password" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Leave blank to keep current password">
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">passwordConfirm</label>
          <input type="password" name="passwordConfirm" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Confirm new password">
        </div>`
            : `<div class="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">Password can only be changed by the matching superadmin or the current owner.</div>`
        }
      `
      : isAuthCollection
        ? `
        ${
          authMethod === "username" || authMethod === "both"
            ? `<div>
          <label class="block text-sm font-medium text-foreground mb-1">username <span class="text-xs text-muted-foreground/70">(required)</span></label>
          <input type="text" name="username" value="${escapeHtml(record.username || "")}" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        </div>`
            : ""
        }
        ${
          authMethod === "email" || authMethod === "both"
            ? `<div>
          <label class="block text-sm font-medium text-foreground mb-1">email <span class="text-xs text-muted-foreground/70">(required)</span></label>
          <input type="email" name="email" value="${escapeHtml(record.email || "")}" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        </div>`
            : ""
        }
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">verified</label>
          ${renderBooleanSelect("verified", record.verified === true || record.verified === "true")}
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">password <span class="text-xs text-muted-foreground/70">(leave blank to keep current)</span></label>
          <input type="password" name="password" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Leave blank to keep current password">
        </div>
        <div>
          <label class="block text-sm font-medium text-foreground mb-1">passwordConfirm</label>
          <input type="password" name="passwordConfirm" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Confirm new password">
        </div>
      `
        : "";

    const fieldsHtml = nonAuthColumns
      .map((col) => {
        const logicalField = definedSchema.find(
          (f) => f.name === col.column_name,
        );
        const logicalType = logicalField
          ? logicalField.type.toLowerCase()
          : col.data_type;
        const currentValue = record[col.column_name];

        if (logicalType === "richtext") {
          addEditSnapshot(col.column_name, record[col.column_name] || "");
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name} <span class="text-xs text-muted-foreground/70">(RichText)</span></label>
            <div class="border rounded-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
              <div class="bg-muted p-2 flex gap-2 border-b">
                 <button type="button" class="px-2 py-1 text-xs bg-background border rounded hover:bg-accent" onclick="document.getElementById('rt_${col.column_name}').value += '<b>bold</b>'">B</button>
                 <button type="button" class="px-2 py-1 text-xs bg-background border rounded hover:bg-accent" onclick="document.getElementById('rt_${col.column_name}').value += '<i>italic</i>'">I</button>
              </div>
              <textarea id="rt_${col.column_name}" name="${col.column_name}" rows="6" class="w-full flex border-0 bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50">${escapeHtml(currentValue || "")}</textarea>
            </div>
          </div>
        `;
        }

        if (logicalType === "geolocation") {
          const geoValue =
            currentValue && typeof currentValue === "object"
              ? currentValue
              : {};
          addEditSnapshot(`${col.column_name}_lat`, geoValue.lat ?? "");
          addEditSnapshot(`${col.column_name}_lon`, geoValue.lon ?? "");
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name} <span class="text-xs text-muted-foreground/70">(Geolocation JSON)</span></label>
            <div class="flex gap-4">
              <input type="number" step="any" name="${col.column_name}_lat" value="${escapeHtml(geoValue.lat ?? "")}" placeholder="Latitude (e.g. 40.71)" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <input type="number" step="any" name="${col.column_name}_lon" value="${escapeHtml(geoValue.lon ?? "")}" placeholder="Longitude (e.g. -74.00)" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            </div>
            <p class="text-xs text-muted-foreground mt-1">Saved automatically as <code>{"lat": x, "lon": y}</code></p>
          </div>
        `;
        }

        if (logicalType === "date_only" || col.data_type === "date") {
          addEditSnapshot(col.column_name, formatDateOnly(currentValue));
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name}</label>
            <input type="date" name="${col.column_name}" value="${escapeHtml(formatDateOnly(currentValue))}" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          </div>
        `;
        }

        if (col.data_type.includes("timestamp")) {
          addEditSnapshot(col.column_name, formatDateTimeLocal(currentValue));
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name}</label>
            <input type="datetime-local" name="${col.column_name}" value="${escapeHtml(formatDateTimeLocal(currentValue))}" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          </div>
        `;
        }

        if (col.data_type === "boolean") {
          addEditSnapshot(
            col.column_name,
            currentValue === true || currentValue === "true" ? "true" : "false",
          );
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name}</label>
            ${renderBooleanSelect(col.column_name, currentValue === true || currentValue === "true")}
          </div>
        `;
        }

        if (col.data_type === "jsonb" || logicalType === "json") {
          const jsonValue =
            currentValue && typeof currentValue === "object"
              ? JSON.stringify(currentValue, null, 2)
              : String(currentValue ?? "");
          addEditSnapshot(col.column_name, jsonValue);
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name}</label>
            <textarea name="${col.column_name}" rows="4" class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">${escapeHtml(jsonValue)}</textarea>
          </div>
        `;
        }

        if (
          col.data_type.includes("int") ||
          col.data_type.includes("numeric")
        ) {
          addEditSnapshot(col.column_name, currentValue ?? "");
          return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name}</label>
            <input type="number" name="${col.column_name}" value="${escapeHtml(currentValue ?? "")}" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          </div>
        `;
        }

        addEditSnapshot(col.column_name, currentValue ?? "");
        return `
          <div>
            <label class="block text-sm font-medium text-foreground mb-1">${col.column_name} <span class="text-xs text-muted-foreground/70">(${col.data_type})</span></label>
            ${
              col.data_type === "text"
                ? `<textarea name="${col.column_name}" rows="3" class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">${escapeHtml(currentValue ?? "")}</textarea>`
                : `<input type="text" name="${col.column_name}" value="${escapeHtml(currentValue ?? "")}" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">`
            }
          </div>
        `;
      })
      .join("");

    if (isAuthCollection) {
      if (authMethod === "username" || authMethod === "both") {
        addEditSnapshot("username", record.username || "");
      }
      if (authMethod === "email" || authMethod === "both") {
        addEditSnapshot("email", record.email || "");
      }
      addEditSnapshot(
        "verified",
        record.verified === true || record.verified === "true"
          ? "true"
          : "false",
      );
      addEditSnapshot("password", "");
      addEditSnapshot("passwordConfirm", "");
    }

    editFieldSnapshotEntries.sort((a, b) => {
      const an = String(a[0]) + ":" + String(a[1]);
      const bn = String(b[0]) + ":" + String(b[1]);
      return an.localeCompare(bn);
    });
    const editRecordInitialSnapshot = JSON.stringify(editFieldSnapshotEntries);

    return c.html(`
      <div data-drawer-backdrop class="fixed inset-0 z-50 bg-black/50 flex justify-end transition-opacity" onclick="if(event.target===this) window.closeDrawer()">
        <div data-drawer-panel class="w-full max-w-md bg-background shadow-xl h-full flex flex-col border-l border-border transform translate-x-0" onclick="event.stopPropagation()">
          <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/20">
            <h2 class="text-lg text-foreground">Edit <span class="font-semibold">${collectionName}</span> record</h2>
            <button type="button" onclick="window.closeDrawer()" class="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground">
              <svg class="w-5 h-5 block" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
          <form id="edit-record-form" method="post" action="${collectionsBase}/${collectionName}/records/${recordId}" hx-post="${collectionsBase}/${collectionName}/records/${recordId}" hx-target="#main-content" data-initial-snapshot="${escapeHtml(editRecordInitialSnapshot)}" oninput="(function(form){const btn=form.querySelector('#update-record-btn'); if(!btn) return; const snapshot=JSON.stringify(Array.from(new FormData(form).entries()).sort(function(a,b){const ak=String(a[0])+':'+String(a[1]); const bk=String(b[0])+':'+String(b[1]); return ak.localeCompare(bk);})); btn.disabled = snapshot === form.dataset.initialSnapshot;})(this)" onchange="(function(form){const btn=form.querySelector('#update-record-btn'); if(!btn) return; const snapshot=JSON.stringify(Array.from(new FormData(form).entries()).sort(function(a,b){const ak=String(a[0])+':'+String(a[1]); const bk=String(b[0])+':'+String(b[1]); return ak.localeCompare(bk);})); btn.disabled = snapshot === form.dataset.initialSnapshot;})(this)" class="flex flex-col h-full overflow-hidden" hx-on::after-request="if (event.detail.successful) window.closeDrawer()">
            <div class="flex-1 overflow-y-auto p-6 space-y-6">
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">id <span class="text-xs text-muted-foreground/70">(read only)</span></label>
                <input type="text" value="${escapeHtml(String(record.id))}" disabled class="w-full flex h-10 rounded-md border border-input bg-muted/40 px-3 py-2 text-sm font-mono text-muted-foreground ring-offset-background focus-visible:outline-none">
              </div>
              ${authFieldsHtml}
              ${fieldsHtml}
            </div>
            <div class="p-4 border-t border-border bg-muted/10 flex justify-end gap-3">
              <button
                type="button"
                class="mr-auto inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground ring-offset-background transition-colors hover:bg-accent hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                hx-post="${collectionsBase}/${collectionName}/records/${recordId}/delete"
                hx-params="none"
                hx-target="#main-content"
                hx-confirm="Delete this record? This action cannot be undone."
                hx-on::after-request="if (event.detail.successful) window.closeDrawer()"
                title="Delete record"
                aria-label="Delete record"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M4 7h16"></path>
                </svg>
              </button>
              ${
                canTransferOwnership
                  ? `<button type="submit" name="transfer_owner" value="true" class="inline-flex items-center justify-center rounded-md border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition hover:bg-primary/15">Transfer Ownership</button>`
                  : ""
              }
              <button type="button" onclick="window.closeDrawer()" class="px-4 py-2 hover:bg-muted rounded-md text-sm font-medium transition">Cancel</button>
              <button id="update-record-btn" type="submit" disabled class="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-2 rounded-md text-sm font-medium transition shadow-sm disabled:pointer-events-none disabled:opacity-50">Update Record</button>
            </div>
          </form>
        </div>
      </div>
    `);
  } catch (err: any) {
    console.error("Load record editor error:", err);
    return c.html(
      `<div class="text-red-500 p-4">Error loading record editor: Internal server error</div>`,
      500,
    );
  }
});

collections.post("/:collection/records", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  const body = await c.req.parseBody();
  const isSystemUsers = isUsersCollection(collectionName);

  try {
    const metaInfo =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName}`;
    const configuredTimeZone = await getConfiguredTimeZone();
    const tableColumns = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = ${collectionName}
        AND table_schema = 'public'
    `;
    const columnTypeByName = new Map<string, string>(
      (tableColumns as any[]).map((col) => [
        String(col.column_name),
        String(col.data_type || "").toLowerCase(),
      ]),
    );
    let definedSchema: any[] = [];
    if (metaInfo.length > 0 && metaInfo[0].schema) {
      definedSchema =
        typeof metaInfo[0].schema === "string"
          ? JSON.parse(metaInfo[0].schema)
          : metaInfo[0].schema;
    }

    if (isSystemUsers) {
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const passwordConfirm = String(body.passwordConfirm || "");

      if (!email) {
        return htmxErrorResponse("email is required for superadmins.");
      }
      if (!password || password.length < 8) {
        return htmxErrorResponse(
          "Password is required and must be at least 8 characters.",
        );
      }
      if (password !== passwordConfirm) {
        return htmxErrorResponse("Password and passwordConfirm must match.");
      }

      const hashedPassword = await Bun.password.hash(password);
      const result = await sql`
        INSERT INTO _users (email, password, owner)
        VALUES (${email}, ${hashedPassword}, FALSE)
        RETURNING id
      `;

      return c.html(`
        <script>
          showToast("Superadmin created.", "success");
          setTimeout(() => {
            if (window.htmx && typeof window.htmx.ajax === 'function') {
              window.htmx.ajax('GET', window.collectionRecordsUrl || '${collectionsBase}/${collectionName}/records', '#main-content');
              return;
            }
            window.location.reload();
          }, 10);
        </script>
      `);
    }

    const isBlankValue = (value: any) =>
      value === undefined || value === null || String(value).trim() === "";

    const validateFieldValue = (fieldDef: any, fieldName: string) => {
      const rawValue = body[fieldName];
      const hasValue = Object.prototype.hasOwnProperty.call(body, fieldName);

      if (fieldDef.required && (!hasValue || isBlankValue(rawValue))) {
        throw new Error(`Field "${fieldName}" is required.`);
      }

      if (!hasValue || isBlankValue(rawValue)) return;

      const fieldType = String(fieldDef.type || "text").toLowerCase();
      const stringValue = String(rawValue);

      switch (fieldType) {
        case "number": {
          const numericValue = Number(rawValue);
          if (!Number.isFinite(numericValue)) {
            throw new Error(`Field "${fieldName}" must be a valid number.`);
          }
          if (fieldDef.nonzero && numericValue === 0) {
            throw new Error(`Field "${fieldName}" must be non-zero.`);
          }
          if (
            fieldDef.min !== undefined &&
            fieldDef.min !== null &&
            fieldDef.min !== ""
          ) {
            const minValue = Number(fieldDef.min);
            if (numericValue < minValue) {
              throw new Error(
                `Field "${fieldName}" must be at least ${minValue}.`,
              );
            }
          }
          if (
            fieldDef.max !== undefined &&
            fieldDef.max !== null &&
            fieldDef.max !== ""
          ) {
            const maxValue = Number(fieldDef.max);
            if (numericValue > maxValue) {
              throw new Error(
                `Field "${fieldName}" must be at most ${maxValue}.`,
              );
            }
          }
          break;
        }
        case "email": {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(stringValue)) {
            throw new Error(`Field "${fieldName}" must be a valid email.`);
          }
          break;
        }
        case "url": {
          try {
            new URL(stringValue);
          } catch {
            throw new Error(`Field "${fieldName}" must be a valid URL.`);
          }
          break;
        }
        case "boolean": {
          if (stringValue !== "true" && stringValue !== "false") {
            throw new Error(`Field "${fieldName}" must be a boolean.`);
          }
          break;
        }
        case "date":
        case "datetime": {
          if (isNaN(Date.parse(stringValue))) {
            throw new Error(`Field "${fieldName}" must be a valid date.`);
          }
          break;
        }
        case "date_only": {
          const format = fieldDef.date_format || "YYYY-MM-DD";
          if (
            format === "YYYY-MM-DD" &&
            !/^\d{4}-\d{2}-\d{2}$/.test(stringValue)
          ) {
            throw new Error(
              `Field "${fieldName}" must be in YYYY-MM-DD format.`,
            );
          }
          break;
        }
        case "json":
        case "jsonb": {
          try {
            JSON.parse(stringValue);
          } catch {
            throw new Error(`Field "${fieldName}" must be valid JSON.`);
          }
          break;
        }
        case "uuid":
        case "relation": {
          const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(stringValue)) {
            throw new Error(`Field "${fieldName}" must be a valid UUID.`);
          }
          break;
        }
        default: {
          if (fieldDef.regex && String(fieldDef.regex).trim()) {
            const regex = new RegExp(fieldDef.regex);
            if (!regex.test(stringValue)) {
              throw new Error(
                `Field "${fieldName}" does not match the required pattern.`,
              );
            }
          }
        }
      }
    };

    const cleanBody: Record<string, any> = {};
    const finalKeys: string[] = [];
    const keys = Object.keys(body).filter((k) => body[k] !== "");

    if (keys.length === 0) {
      return c.json({ error: "Empty payload" }, 422);
    }

    const isAuthCollection = metaInfo.length > 0 && metaInfo[0].type === "auth";
    let authMethod = "email";
    if (isAuthCollection && metaInfo[0].oauth2) {
      try {
        const oauthCfg =
          typeof metaInfo[0].oauth2 === "string"
            ? JSON.parse(metaInfo[0].oauth2)
            : metaInfo[0].oauth2;
        authMethod = oauthCfg?.auth_method || "email";
      } catch (e) {}
    }

    for (const fieldDef of definedSchema) {
      if (!fieldDef || !fieldDef.name) continue;
      if (fieldDef.system || fieldDef.name === "id") {
        continue;
      }
      if (fieldDef.type === "password" || fieldDef.name === "passwordConfirm") {
        continue;
      }

      if (fieldDef.type === "geolocation") {
        const latKey = `${fieldDef.name}_lat`;
        const lonKey = `${fieldDef.name}_lon`;
        const hasLat = Object.prototype.hasOwnProperty.call(body, latKey);
        const hasLon = Object.prototype.hasOwnProperty.call(body, lonKey);
        const latValue = body[latKey];
        const lonValue = body[lonKey];

        if (
          fieldDef.required &&
          (!hasLat ||
            !hasLon ||
            isBlankValue(latValue) ||
            isBlankValue(lonValue))
        ) {
          throw new Error(`Field "${fieldDef.name}" is required.`);
        }

        if (
          hasLat &&
          !isBlankValue(latValue) &&
          !Number.isFinite(Number(latValue))
        ) {
          throw new Error(
            `Field "${fieldDef.name}" latitude must be a valid number.`,
          );
        }
        if (
          hasLon &&
          !isBlankValue(lonValue) &&
          !Number.isFinite(Number(lonValue))
        ) {
          throw new Error(
            `Field "${fieldDef.name}" longitude must be a valid number.`,
          );
        }
        continue;
      }

      validateFieldValue(fieldDef, fieldDef.name);
    }

    if (isAuthCollection) {
      const password = (body.password as string) || "";
      const passwordConfirm = (body.passwordConfirm as string) || "";

      if (!password || password.length < 8) {
        return htmxErrorResponse(
          "Password is required and must be at least 8 characters.",
        );
      }
      if (password !== passwordConfirm) {
        return htmxErrorResponse("Password and passwordConfirm must match.");
      }

      if (authMethod === "username" || authMethod === "both") {
        if (isBlankValue(body.username)) {
          return htmxErrorResponse(
            "username is required for this auth collection.",
          );
        }
      } else {
        delete cleanBody.username;
      }

      if (authMethod === "email" || authMethod === "both") {
        if (isBlankValue(body.email)) {
          return htmxErrorResponse(
            "email is required for this auth collection.",
          );
        }
      } else {
        delete cleanBody.email;
      }

      cleanBody.verified = body.verified === "true";
      const hashResult =
        await sql`SELECT crypt(${password}, gen_salt('bf')) as hash`;
      cleanBody.password_hash = hashResult[0].hash;
      delete cleanBody.password;
      delete cleanBody.passwordConfirm;

      if (!finalKeys.includes("verified")) finalKeys.push("verified");
      if (!finalKeys.includes("password_hash")) finalKeys.push("password_hash");
      ["password", "passwordConfirm"].forEach((k) => {
        const idx = finalKeys.indexOf(k);
        if (idx > -1) finalKeys.splice(idx, 1);
      });
    }

    // Group geolocation keys properly
    keys.forEach((k) => {
      const fieldDef = definedSchema.find((f) => f.name === k);
      const columnType = columnTypeByName.get(k) || "";

      if (k.endsWith("_lat")) {
        const baseName = k.replace("_lat", "");
        if (!cleanBody[baseName]) cleanBody[baseName] = {};
        cleanBody[baseName].lat = parseFloat(body[k] as string);
        if (!finalKeys.includes(baseName)) finalKeys.push(baseName);
      } else if (k.endsWith("_lon")) {
        const baseName = k.replace("_lon", "");
        if (!cleanBody[baseName]) cleanBody[baseName] = {};
        cleanBody[baseName].lon = parseFloat(body[k] as string);
        if (!finalKeys.includes(baseName)) finalKeys.push(baseName);
      } else if (fieldDef && fieldDef.type === "date_only") {
        let val = String(body[k] ?? "").trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
        if (m) {
          const yyyy = m[1];
          const mm = m[2];
          const dd = m[3];
          const fmt = fieldDef.date_format || "YYYY-MM-DD";
          if (fmt === "DD-MM-YYYY") val = `${dd}-${mm}-${yyyy}`;
          else if (fmt === "DD/MM/YYYY") val = `${dd}/${mm}/${yyyy}`;
          else if (fmt === "YYYY/MM/DD") val = `${yyyy}/${mm}/${dd}`;
          else val = `${yyyy}-${mm}-${dd}`;
        }
        cleanBody[k] = val;
        finalKeys.push(k);
      } else if (fieldDef && shouldTrimTextInput(fieldDef)) {
        cleanBody[k] = normalizeTextInputValue(fieldDef, body[k]);
        finalKeys.push(k);
      } else if (
        columnType.includes("timestamp") &&
        typeof body[k] === "string" &&
        /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(body[k] as string)
      ) {
        cleanBody[k] = convertLocalDateTimeInTimeZoneToUtcIso(
          body[k] as string,
          configuredTimeZone,
        );
        finalKeys.push(k);
      } else {
        cleanBody[k] = body[k];
        finalKeys.push(k);
      }
    });

    // Optional manual id support on create; if blank, DB default gen_random_uuid() is used.
    if (
      cleanBody.id === "" ||
      cleanBody.id === null ||
      cleanBody.id === undefined
    ) {
      delete cleanBody.id;
      const idx = finalKeys.indexOf("id");
      if (idx > -1) finalKeys.splice(idx, 1);
    }

    const result = await sql`
      INSERT INTO ${sql(collectionName)} ${sql(cleanBody, finalKeys as any)}
      RETURNING id
    `;

    return c.html(`
      <script>
        showToast("Record created.", "success");
        setTimeout(() => {
          if (window.htmx && typeof window.htmx.ajax === 'function') {
            window.htmx.ajax('GET', window.collectionRecordsUrl || '${collectionsBase}/${collectionName}/records', '#main-content');
            return;
          }
          window.location.reload();
        }, 10);
      </script>
    `);
  } catch (err: any) {
    const errMsg =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    return htmxErrorResponse(`Error creating record: ${errMsg}`);
  }
});

collections.post("/:collection/records/:id", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  const recordId = c.req.param("id");
  const body = await c.req.parseBody();

  try {
    const metaRows =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    const isSystemUsers = collectionName === "_users";
    if (metaRows.length === 0 && !isSystemUsers) {
      return htmxErrorResponse("Collection not found.");
    }
    const metaInfo =
      metaRows.length > 0
        ? metaRows
        : [{ type: "base", schema: null, oauth2: null }];
    if (metaInfo[0].type === "view") {
      return htmxErrorResponse("Views are read only.");
    }

    const existingRows = await sql`
      SELECT * FROM ${sql(collectionName)} WHERE id = ${recordId} LIMIT 1
    `;
    if (existingRows.length === 0) {
      return htmxErrorResponse("Record not found.");
    }

    const existingRecord = existingRows[0];
    if (isSystemUsers) {
      const currentAdminRecord = await getCurrentAdminRecord(c);
      const currentAdminId = currentAdminRecord?.id || null;
      const currentAdminOwns = currentAdminRecord?.owner === true;
      const nextEmail = String(body.email || "").trim();
      const requestedPassword = String(body.password || "");
      const requestedPasswordConfirm = String(body.passwordConfirm || "");
      const wantsOwnership = body.transfer_owner === "true";

      if (requestedPassword || requestedPasswordConfirm) {
        if (
          !currentAdminId ||
          (recordId !== currentAdminId && !currentAdminOwns)
        ) {
          return htmxErrorResponse(
            "You can only change your own password unless you are the current owner.",
            403,
          );
        }
        if (!requestedPassword || requestedPassword.length < 8) {
          return htmxErrorResponse(
            "Password must be at least 8 characters when updated.",
          );
        }
        if (requestedPassword !== requestedPasswordConfirm) {
          return htmxErrorResponse("Password and passwordConfirm must match.");
        }
      }

      if (wantsOwnership && !currentAdminOwns) {
        return htmxErrorResponse(
          "Only the current owner can assign ownership.",
          403,
        );
      }

      const escapeSqlLiteral = (value: any) => {
        if (value === null || value === undefined) return "NULL";
        if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
        return `'${String(value).replace(/'/g, "''")}'`;
      };

      const assignments: string[] = [];
      if (nextEmail) {
        assignments.push(`"email" = ${escapeSqlLiteral(nextEmail)}`);
      }

      if (requestedPassword) {
        const hashResult = await sql`
          SELECT crypt(${requestedPassword}, gen_salt('bf')) as hash
        `;
        assignments.push(
          `"password" = ${escapeSqlLiteral(hashResult[0].hash)}`,
        );
      }

      if (assignments.length > 0) {
        await sql.unsafe(
          `UPDATE _users SET ${assignments.join(", ")} WHERE id = ${escapeSqlLiteral(recordId)}`,
        );
      }

      if (wantsOwnership) {
        await sql`UPDATE _users SET owner = (id = ${recordId})`;
      }

      if (assignments.length === 0 && !wantsOwnership) {
        return htmxErrorResponse("No changes to save.", 409);
      }

      return c.html(`
        <script>
          showToast("Superadmin updated.", "success");
          setTimeout(() => {
            document.getElementById('drawer-container').innerHTML = '';
            if (window.htmx && typeof window.htmx.ajax === 'function') {
              window.htmx.ajax('GET', window.collectionRecordsUrl || '${collectionsBase}/${collectionName}/records', '#main-content');
              return;
            }
            window.location.reload();
          }, 10);
        </script>
      `);
    }

    const configuredTimeZone = await getConfiguredTimeZone();
    const tableColumns = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = ${collectionName}
        AND table_schema = 'public'
    `;
    const columnTypeByName = new Map<string, string>(
      (tableColumns as any[]).map((col) => [
        String(col.column_name),
        String(col.data_type || "").toLowerCase(),
      ]),
    );

    let definedSchema: any[] = [];
    if (metaInfo.length > 0 && metaInfo[0].schema) {
      definedSchema =
        typeof metaInfo[0].schema === "string"
          ? JSON.parse(metaInfo[0].schema)
          : metaInfo[0].schema;
    }

    const isBlankValue = (value: any) =>
      value === undefined || value === null || String(value).trim() === "";

    const validateFieldValue = (fieldDef: any, fieldName: string) => {
      const hasValue = Object.prototype.hasOwnProperty.call(body, fieldName);
      const rawValue = body[fieldName];

      if (fieldDef.required && (!hasValue || isBlankValue(rawValue))) {
        throw new Error(`Field "${fieldName}" is required.`);
      }

      if (!hasValue || isBlankValue(rawValue)) return;

      const fieldType = String(fieldDef.type || "text").toLowerCase();
      const stringValue = String(rawValue);

      switch (fieldType) {
        case "number": {
          const numericValue = Number(rawValue);
          if (!Number.isFinite(numericValue)) {
            throw new Error(`Field "${fieldName}" must be a valid number.`);
          }
          if (fieldDef.nonzero && numericValue === 0) {
            throw new Error(`Field "${fieldName}" must be non-zero.`);
          }
          if (
            fieldDef.min !== undefined &&
            fieldDef.min !== null &&
            fieldDef.min !== ""
          ) {
            const minValue = Number(fieldDef.min);
            if (numericValue < minValue) {
              throw new Error(
                `Field "${fieldName}" must be at least ${minValue}.`,
              );
            }
          }
          if (
            fieldDef.max !== undefined &&
            fieldDef.max !== null &&
            fieldDef.max !== ""
          ) {
            const maxValue = Number(fieldDef.max);
            if (numericValue > maxValue) {
              throw new Error(
                `Field "${fieldName}" must be at most ${maxValue}.`,
              );
            }
          }
          break;
        }
        case "email": {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(stringValue)) {
            throw new Error(`Field "${fieldName}" must be a valid email.`);
          }
          break;
        }
        case "url": {
          try {
            new URL(stringValue);
          } catch {
            throw new Error(`Field "${fieldName}" must be a valid URL.`);
          }
          break;
        }
        case "boolean": {
          if (stringValue !== "true" && stringValue !== "false") {
            throw new Error(`Field "${fieldName}" must be a boolean.`);
          }
          break;
        }
        case "date":
        case "datetime": {
          if (isNaN(Date.parse(stringValue))) {
            throw new Error(`Field "${fieldName}" must be a valid date.`);
          }
          break;
        }
        case "date_only": {
          const format = fieldDef.date_format || "YYYY-MM-DD";
          if (
            format === "YYYY-MM-DD" &&
            !/^\d{4}-\d{2}-\d{2}$/.test(stringValue)
          ) {
            throw new Error(
              `Field "${fieldName}" must be in YYYY-MM-DD format.`,
            );
          }
          break;
        }
        case "json":
        case "jsonb": {
          try {
            JSON.parse(stringValue);
          } catch {
            throw new Error(`Field "${fieldName}" must be valid JSON.`);
          }
          break;
        }
        case "uuid":
        case "relation": {
          const uuidRegex =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(stringValue)) {
            throw new Error(`Field "${fieldName}" must be a valid UUID.`);
          }
          break;
        }
        default: {
          if (fieldDef.regex && String(fieldDef.regex).trim()) {
            const regex = new RegExp(fieldDef.regex);
            if (!regex.test(stringValue)) {
              throw new Error(
                `Field "${fieldName}" does not match the required pattern.`,
              );
            }
          }
        }
      }
    };

    for (const fieldDef of definedSchema) {
      if (!fieldDef || !fieldDef.name) continue;
      if (
        fieldDef.system ||
        fieldDef.type === "password" ||
        fieldDef.name === "passwordConfirm"
      ) {
        continue;
      }

      if (fieldDef.type === "geolocation") {
        const latKey = `${fieldDef.name}_lat`;
        const lonKey = `${fieldDef.name}_lon`;
        const hasLat = Object.prototype.hasOwnProperty.call(body, latKey);
        const hasLon = Object.prototype.hasOwnProperty.call(body, lonKey);
        const latValue = body[latKey];
        const lonValue = body[lonKey];

        if (
          fieldDef.required &&
          (!hasLat ||
            !hasLon ||
            isBlankValue(latValue) ||
            isBlankValue(lonValue))
        ) {
          throw new Error(`Field "${fieldDef.name}" is required.`);
        }

        if (
          hasLat &&
          !isBlankValue(latValue) &&
          !Number.isFinite(Number(latValue))
        ) {
          throw new Error(
            `Field "${fieldDef.name}" latitude must be a valid number.`,
          );
        }
        if (
          hasLon &&
          !isBlankValue(lonValue) &&
          !Number.isFinite(Number(lonValue))
        ) {
          throw new Error(
            `Field "${fieldDef.name}" longitude must be a valid number.`,
          );
        }
        continue;
      }

      validateFieldValue(fieldDef, fieldDef.name);
    }

    const isAuthCollection = metaInfo.length > 0 && metaInfo[0].type === "auth";
    let authMethod = "email";
    if (isAuthCollection && metaInfo[0].oauth2) {
      try {
        const oauthCfg =
          typeof metaInfo[0].oauth2 === "string"
            ? JSON.parse(metaInfo[0].oauth2)
            : metaInfo[0].oauth2;
        authMethod = oauthCfg?.auth_method || "email";
      } catch (e) {}
    }

    const cleanBody: Record<string, any> = {};
    const finalKeys: string[] = [];
    const keys = Object.keys(body).filter((k) => body[k] !== "");

    keys.forEach((k) => {
      if (k === "passwordConfirm") return;

      const fieldDef = definedSchema.find((f) => f.name === k);
      const columnType = columnTypeByName.get(k) || "";

      if (k.endsWith("_lat")) {
        const baseName = k.replace("_lat", "");
        if (!cleanBody[baseName])
          cleanBody[baseName] = existingRecord[baseName] || {};
        cleanBody[baseName].lat = parseFloat(body[k] as string);
        if (!finalKeys.includes(baseName)) finalKeys.push(baseName);
      } else if (k.endsWith("_lon")) {
        const baseName = k.replace("_lon", "");
        if (!cleanBody[baseName])
          cleanBody[baseName] = existingRecord[baseName] || {};
        cleanBody[baseName].lon = parseFloat(body[k] as string);
        if (!finalKeys.includes(baseName)) finalKeys.push(baseName);
      } else if (fieldDef && fieldDef.type === "date_only") {
        let val = String(body[k] ?? "").trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
        if (m) {
          const yyyy = m[1];
          const mm = m[2];
          const dd = m[3];
          const fmt = fieldDef.date_format || "YYYY-MM-DD";
          if (fmt === "DD-MM-YYYY") val = `${dd}-${mm}-${yyyy}`;
          else if (fmt === "DD/MM/YYYY") val = `${dd}/${mm}/${yyyy}`;
          else if (fmt === "YYYY/MM/DD") val = `${yyyy}/${mm}/${dd}`;
          else val = `${yyyy}-${mm}-${dd}`;
        }
        cleanBody[k] = val;
        finalKeys.push(k);
      } else if (fieldDef && shouldTrimTextInput(fieldDef)) {
        cleanBody[k] = normalizeTextInputValue(fieldDef, body[k]);
        finalKeys.push(k);
      } else if (
        columnType.includes("timestamp") &&
        typeof body[k] === "string" &&
        /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/.test(body[k] as string)
      ) {
        cleanBody[k] = convertLocalDateTimeInTimeZoneToUtcIso(
          body[k] as string,
          configuredTimeZone,
        );
        finalKeys.push(k);
      } else if (
        (fieldDef && fieldDef.type === "boolean") ||
        k === "verified"
      ) {
        cleanBody[k] = String(body[k]) === "true";
        finalKeys.push(k);
      } else {
        cleanBody[k] = body[k];
        finalKeys.push(k);
      }
    });

    if (isAuthCollection) {
      const password = (body.password as string) || "";
      const passwordConfirm = (body.passwordConfirm as string) || "";

      if (password) {
        if (password.length < 8) {
          return htmxErrorResponse(
            "Password must be at least 8 characters when updated.",
          );
        }
        if (password !== passwordConfirm) {
          return htmxErrorResponse("Password and passwordConfirm must match.");
        }

        const hashResult =
          await sql`SELECT crypt(${password}, gen_salt('bf')) as hash`;
        cleanBody.password_hash = hashResult[0].hash;
        if (!finalKeys.includes("password_hash"))
          finalKeys.push("password_hash");
      }

      if (authMethod === "username" || authMethod === "both") {
        if (!cleanBody.username && existingRecord.username) {
          cleanBody.username = existingRecord.username;
        }
      } else {
        delete cleanBody.username;
        const idx = finalKeys.indexOf("username");
        if (idx > -1) finalKeys.splice(idx, 1);
      }

      if (authMethod === "email" || authMethod === "both") {
        if (!cleanBody.email && existingRecord.email) {
          cleanBody.email = existingRecord.email;
        }
      } else {
        delete cleanBody.email;
        const idx = finalKeys.indexOf("email");
        if (idx > -1) finalKeys.splice(idx, 1);
      }

      if (
        !finalKeys.includes("verified") &&
        existingRecord.verified !== undefined
      ) {
        cleanBody.verified = String(body.verified) === "true";
        finalKeys.push("verified");
      }

      delete cleanBody.password;
      delete cleanBody.passwordConfirm;
      ["password", "passwordConfirm"].forEach((k) => {
        const idx = finalKeys.indexOf(k);
        if (idx > -1) finalKeys.splice(idx, 1);
      });
    }

    if (Object.prototype.hasOwnProperty.call(existingRecord, "updated_at")) {
      cleanBody.updated_at = new Date().toISOString();
      if (!finalKeys.includes("updated_at")) finalKeys.push("updated_at");
    }

    const escapeSqlLiteral = (value: any) => {
      if (value === null || value === undefined) return "NULL";
      if (typeof value === "number" && Number.isFinite(value))
        return String(value);
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      if (value instanceof Date)
        return `'${value.toISOString().replace(/'/g, "''")}'`;
      if (typeof value === "object") {
        return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
      }
      return `'${String(value).replace(/'/g, "''")}'`;
    };

    const updateAssignments = finalKeys
      .filter((key) => key !== "id")
      .map(
        (key) =>
          `"${key.replace(/"/g, '""')}" = ${escapeSqlLiteral(cleanBody[key])}`,
      );

    if (updateAssignments.length === 0) {
      return htmxErrorResponse("No changes to save.", 409);
    }

    await sql.unsafe(
      `UPDATE ${quoteIdentifier(collectionName)} SET ${updateAssignments.join(", ")} WHERE id = ${escapeSqlLiteral(recordId)}`,
    );

    return c.html(`
      <script>
        showToast("Record updated.", "success");
        setTimeout(() => {
          document.getElementById('drawer-container').innerHTML = '';
          if (window.htmx && typeof window.htmx.ajax === 'function') {
            window.htmx.ajax('GET', window.collectionRecordsUrl || '${collectionsBase}/${collectionName}/records', '#main-content');
            return;
          }
          window.location.reload();
        }, 10);
      </script>
    `);
  } catch (err: any) {
    const errMsg =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    return htmxErrorResponse(`Error updating record: ${errMsg}`);
  }
});

collections.post("/:collection/records/:id/delete", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  const recordId = c.req.param("id");

  try {
    const metaInfo =
      await sql`SELECT type FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (metaInfo.length === 0) {
      return c.html(
        `<script>showToast("Collection not found.", "error");</script>`,
        404,
      );
    }
    if (metaInfo[0].type === "view") {
      return c.html(
        `<script>showToast("Views are read only.", "error");</script>`,
        405,
      );
    }

    if (isUsersCollection(collectionName)) {
      const targetRows = await sql`
        SELECT id, owner FROM _users WHERE id = ${recordId} LIMIT 1
      `;
      if (targetRows.length === 0) {
        return c.html(
          `<script>showToast("Record not found.", "error");</script>`,
          404,
        );
      }
      if (targetRows[0].owner === true) {
        return c.html(
          `<script>showToast("Transfer ownership before deleting the current owner.", "error");</script>`,
          403,
        );
      }
    }

    const deleted = await sql`
      DELETE FROM ${sql(collectionName)} WHERE id = ${recordId} RETURNING id
    `;

    if (deleted.length === 0) {
      return c.html(
        `<script>showToast("Record not found.", "error");</script>`,
        404,
      );
    }

    return c.html(`
      <script>
        showToast("Record deleted.", "success");
        setTimeout(() => {
          document.getElementById('drawer-container').innerHTML = '';
          const currentUrl = new URL(window.location.href);
          currentUrl.searchParams.delete('recordId');
          window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
          if (window.htmx && typeof window.htmx.ajax === 'function') {
            window.htmx.ajax('GET', window.collectionRecordsUrl || '${collectionsBase}/${collectionName}/records', '#main-content');
            return;
          }
          window.location.reload();
        }, 10);
      </script>
    `);
  } catch (err: any) {
    const errMsg =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    return c.html(
      `<script>showToast(${JSON.stringify("Error deleting record: " + errMsg)}, "error");</script>`,
    );
  }
});

collections.get("/:collection/settings", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  try {
    const meta =
      await sql`SELECT * FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0)
      return c.html(
        `<div class="text-red-500 p-4">Settings not found!</div>`,
        404,
      );

    const col = meta[0];
    if (typeof col.oauth2 === "string") {
      try {
        col.oauth2 = JSON.parse(col.oauth2);
      } catch (e) {}
    }

    if (typeof col.schema === "string") {
      try {
        col.schema = JSON.parse(col.schema);
      } catch (e) {
        try {
          col.schema = JSON.parse(col.schema.replace(/::jsonb\s*$/i, ""));
        } catch (_e) {}
      }
    }

    // Check if global google oauth is enabled
    let globalGoogleEnabled = false;
    try {
      const gSet =
        await sql`SELECT value FROM _settings WHERE key = 'google_oauth' LIMIT 1`;
      if (gSet.length > 0) {
        const v =
          typeof gSet[0].value === "string"
            ? JSON.parse(gSet[0].value)
            : gSet[0].value;
        globalGoogleEnabled = v.enabled === true;
      }
    } catch (e) {}

    // Pull real DB unique/index metadata for existing fields
    let existingIndexes: string = "[]";
    let multiIndexes: any[] = [];
    if (col.type !== "view") {
      try {
        const idxRes = await sql`
          SELECT
              i.indisunique,
              a.attname as column_name,
              i.indkey
          FROM   pg_index i
          JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE  i.indrelid = ${collectionName}::regclass
        `;

        const idxMap = new Map();
        idxRes.forEach((row: any) => {
          if (!idxMap.has(row.indkey))
            idxMap.set(row.indkey, { unique: row.indisunique, cols: [] });
          idxMap.get(row.indkey).cols.push(row.column_name);
        });

        idxMap.forEach((val) => {
          // ignore primary key logic since id is system
          if (
            val.cols.length === 1 &&
            val.cols[0] !== "id" &&
            !val.cols[0].includes(" ")
          ) {
            // Single column indexes handled in Indexes & Constraints section
          } else if (val.cols.length > 1) {
            multiIndexes.push({
              fields: val.cols.join(", "),
              type: val.unique ? "unique" : "index",
            });
          }
        });

        existingIndexes = JSON.stringify(multiIndexes);
      } catch (e) {
        // Keep empty arrays on error
      }
    }

    return c.html(`
      <div data-drawer-backdrop class="fixed inset-0 z-50 bg-black/50 flex justify-end transition-opacity" onclick="if(event.target===this) window.closeDrawer()">
        <div data-drawer-panel class="w-full max-w-2xl bg-background shadow-xl h-full flex flex-col border-l border-border transform translate-x-0" onclick="event.stopPropagation()">
          <div class="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/20">
            <h2 class="text-xl font-bold text-foreground">Edit Collection</h2>
            <button type="button" onclick="window.closeDrawer()" class="p-2 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground">
              <svg class="w-5 h-5 block" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
        
        <form id="collection-settings-form" hx-post="${collectionsBase}/${collectionName}/settings" hx-target="#main-content" class="flex-1 min-h-0 flex flex-col overflow-hidden" hx-on::after-request="if (event.detail.successful) window.closeDrawer()">
          <div class="flex-1 overflow-y-auto p-6 space-y-6">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="mb-1 block text-sm font-medium text-foreground/80">Collection Name</label>
                <input type="text" name="name" value="${collectionName}" class="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required title="Only alphanumeric characters and underscores allowed. Spaces will be converted.">
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-foreground/80">Type</label>
                <input type="text" value="${col.type.toUpperCase()}" class="flex h-9 w-full rounded-md border border-border bg-muted/30 px-3 py-1 text-sm font-mono text-muted-foreground" disabled>
              </div>
            </div>

            <input type="hidden" name="schema_payload" id="schema_payload" value="">

            <div class="border-b border-border">
              <div class="inline-flex gap-2 rounded-md bg-muted/30 p-1" role="tablist" aria-label="Edit collection tabs">
                <button type="button" data-settings-tab-btn="field" onclick="window.switchCollectionSettingsTab('field')" class="h-8 rounded-md bg-background px-3 text-sm font-medium text-foreground shadow-sm">Field</button>
                <button type="button" data-settings-tab-btn="rules" onclick="window.switchCollectionSettingsTab('rules')" class="h-8 rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground">Rules &amp; Options</button>
              </div>
            </div>

            <div id="settings-tab-field" data-settings-tab-panel="field" class="space-y-6">
              ${
                col.type !== "view"
                  ? `
              <div>
                <div class="flex items-center justify-between mb-2">
                  <h3 class="text-md font-bold text-foreground">Fields Schema Configuration</h3>
                </div>
                <p class="text-xs text-muted-foreground mb-4">Adding, renaming, or deleting fields will actively modify the underlying Postgres table schemas automatically.</p>

                <div class="rounded bg-muted/30 p-3" id="schema-fields-container">
                   <!-- Existing schema loaded by JS -->
                </div>

                <div class="mt-3">
                   <button type="button" onclick="addNewFieldRow()" class="text-sm font-medium text-primary hover:underline">+ Add New Field</button>
                </div>

                <div id="indexes-section" class="mt-6 border-t border-border pt-4">
                  <div class="flex items-center justify-between mb-4">
                    <label class="block text-sm font-medium text-foreground">Indexes & Constraints</label>
                    <button type="button" onclick="addIndex()" class="text-xs bg-primary/10 hover:bg-primary/20 text-primary px-3 py-1 rounded font-medium flex items-center gap-1 transition">
                      + Add Index / Unique
                    </button>
                  </div>
                  <div id="indexes-list" class="space-y-3">
                    <!-- Indexes dynamically inserted here -->
                  </div>
                </div>
              </div>
              `
                  : `
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">View Query (SELECT statement)</label>
                <textarea name="view_query" rows="10" class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono" placeholder="SELECT id, email FROM _users">${String(col.view_query || "")}</textarea>
                <p class="text-xs text-muted-foreground mt-2">Updating this query will replace the underlying SQL view definition.</p>
              </div>
              `
              }
            </div>

            <div id="settings-tab-rules" data-settings-tab-panel="rules" class="space-y-6 hidden">
              ${
                col.type === "auth"
                  ? `
              <div class="bg-muted/30 border border-border rounded p-4">
                <h3 class="text-md font-bold text-foreground mb-2">OAuth2 Providers</h3>
                ${
                  globalGoogleEnabled
                    ? `
                  <div class="space-y-4">
                     <div>
                        <label class="flex items-center space-x-2">
                           <input type="checkbox" name="google_enabled" value="true" ${col.oauth2?.google_enabled ? "checked" : ""} class="rounded border-input text-primary focus:ring-primary h-4 w-4">
                           <span class="text-sm font-medium">Enable Google Login for this collection</span>
                        </label>
                     </div>
                     <div class="pl-6 pt-2">
                       <p class="text-xs text-muted-foreground">Callback URI: <code class="bg-muted px-1 py-0.5 rounded text-foreground">/api/collections/auth-with-oauth2/google/callback</code></p>
                     </div>
                  </div>
                `
                    : `
                  <p class="text-sm text-muted-foreground">Google OAuth2 is disabled globally. Enable it in <a href="#" onclick="window.closeDrawer()" hx-get="${collectionsBase}/system-settings" hx-target="#main-content" hx-push-url="/settings" class="text-primary hover:underline">System Settings</a>.</p>
                `
                }
              </div>
              `
                  : ""
              }

              <div>
                <div class="flex items-center justify-between mb-2 mt-6">
                  <h3 class="text-md font-bold text-foreground">API Rules</h3>
                </div>
                <p class="text-xs text-muted-foreground mb-4 font-mono">Press <code class="bg-muted px-1 py-0.5 rounded">/</code> or <code class="bg-muted px-1 py-0.5 rounded">Ctrl/Cmd+Space</code> to show suggestions</p>
                <div class="space-y-5">
                  ${["List", "View", "Create", "Update", "Delete"]
                    .map((rule) => {
                      const dbKey = rule.toLowerCase() + "_rule";
                      const cv = col[dbKey];
                      const displayVal =
                        cv === null ? "" : typeof cv === "string" ? cv : "";
                      const isLocked = !displayVal;
                      const viewDisabled =
                        col.type === "view" &&
                        ["Create", "Update", "Delete"].includes(rule)
                          ? "disabled bg-gray-100 cursor-not-allowed opacity-50"
                          : "";
                      return `
                    <div class="bg-muted/30 border border-border rounded-md p-4 rule-container">
                      <div class="flex items-center justify-between mb-2">
                        <label class="block text-sm font-semibold text-foreground">${rule} Rule</label>
                        <button type="button" class="rule-lock-btn p-1.5 text-muted-foreground hover:bg-muted rounded transition" data-rule-type="${rule.toLowerCase()}" data-locked="${isLocked}" onclick="toggleRuleLock(this)">
                          ${isLocked ? '<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1m0 20c-4.975 0-9-4.025-9-9s4.025-9 9-9 9 4.025 9 9-4.025 9-9 9m3.5-9c0 1.933-1.567 3.5-3.5 3.5S8.5 13.933 8.5 12 10.067 8.5 12 8.5s3.5 1.567 3.5 3.5"></path></svg>' : '<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10h12V7c0-.551.449-1 1-1s1 .449 1 1v3h1c.551 0 1 .449 1 1v10c0 .551-.449 1-1 1H6c-.551 0-1-.449-1-1V11c0-.551.449-1 1-1h1V7c0-3.866 3.134-7 7-7s7 3.134 7 7v2c0 .551-.449 1-1 1s-1-.449-1-1V7c0-2.757-2.243-5-5-5s-5 2.243-5 5v3z"></path></svg>'}
                        </button>
                      </div>
                      <textarea name="${dbKey}" placeholder="Admin only - click lock icon to edit" class="w-full h-24 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none rule-input" data-rule-type="${rule.toLowerCase()}" ${isLocked ? "disabled" : ""} ${viewDisabled}>${displayVal}</textarea>
                    </div>
                    `;
                    })
                    .join("")}
                </div>
              </div>
            </div>
          </div>

          <div class="p-4 border-t border-border bg-muted/10 flex justify-between items-center">
            <button type="button" hx-delete="${collectionsBase}/${collectionName}" hx-confirm="Are you sure you want to delete the ENTIRE '${collectionName}' collection and all its records? This action cannot be reversed." hx-target="#main-content" onclick="setTimeout(() => window.closeDrawer(), 200)" class="inline-flex items-center justify-center rounded-md transition-colors bg-transparent text-red-600 hover:bg-red-50 h-10 w-10 border border-transparent hover:border-red-100" title="Delete Collection" aria-label="Delete Collection">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
            <div class="flex gap-3">
              <button type="button" onclick="window.closeDrawer()" class="px-4 py-2 hover:bg-muted rounded-md text-sm font-medium transition">Cancel</button>
              <button id="save-settings-btn" type="submit" onclick="syncSchemaPayload()" disabled class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2 shadow-sm">Save Settings</button>
            </div>
          </div>
        </form>
        </div>
      </div>
      <script>
        window.switchCollectionSettingsTab = function(tab) {
          const fieldBtn = document.querySelector('[data-settings-tab-btn="field"]');
          const rulesBtn = document.querySelector('[data-settings-tab-btn="rules"]');
          const fieldPanel = document.querySelector('[data-settings-tab-panel="field"]');
          const rulesPanel = document.querySelector('[data-settings-tab-panel="rules"]');
          if (!fieldBtn || !rulesBtn || !fieldPanel || !rulesPanel) return;

          const showField = tab === 'field';
          fieldPanel.classList.toggle('hidden', !showField);
          rulesPanel.classList.toggle('hidden', showField);

          fieldBtn.className = showField
            ? 'h-8 px-3 rounded text-sm font-medium bg-background text-foreground shadow-sm'
            : 'h-8 px-3 rounded text-sm font-medium text-muted-foreground hover:text-foreground';
          rulesBtn.className = showField
            ? 'h-8 px-3 rounded text-sm font-medium text-muted-foreground hover:text-foreground'
            : 'h-8 px-3 rounded text-sm font-medium bg-background text-foreground shadow-sm';
        };
        window.switchCollectionSettingsTab('field');

        if (!window.initializeRuleEditors) {
          window.RULE_COMPLETIONS = window.RULE_COMPLETIONS || [
            { text: '@request.auth.id', displayText: '@request.auth.id' },
            { text: '@request.auth.email', displayText: '@request.auth.email' },
            { text: '@request.body', displayText: '@request.body' },
            { text: '@request.query', displayText: '@request.query' },
            { text: '@request.method', displayText: '@request.method' },
            { text: '@request.collection.name', displayText: '@request.collection.name' },
            { text: '@record.id', displayText: '@record.id' },
            { text: '@record.owner_id', displayText: '@record.owner_id' },
            { text: '@record.created_at', displayText: '@record.created_at' },
            { text: 'exists(', displayText: 'exists(field)' },
            { text: 'len(', displayText: 'len(value)' },
            { text: 'lower(', displayText: 'lower(text)' },
            { text: 'upper(', displayText: 'upper(text)' },
            { text: 'trim(', displayText: 'trim(text)' },
            { text: 'contains(', displayText: 'contains(text, substring)' },
            { text: 'startsWith(', displayText: 'startsWith(text, prefix)' },
            { text: 'endsWith(', displayText: 'endsWith(text, suffix)' },
            { text: 'matches(', displayText: 'matches(text, regex)' },
            { text: 'coalesce(', displayText: 'coalesce(val1, val2, ...)' },
            { text: ' = ', displayText: '= (equals)' },
            { text: ' != ', displayText: '!= (not equals)' },
            { text: ' > ', displayText: '> (greater than)' },
            { text: ' < ', displayText: '< (less than)' },
            { text: ' >= ', displayText: '>= (greater or equal)' },
            { text: ' <= ', displayText: '<= (less or equal)' },
            { text: ' ~ ', displayText: '~ (contains)' },
            { text: ' !~ ', displayText: '!~ (not contains)' },
            { text: ' in ', displayText: 'in (array membership)' },
            { text: ' && ', displayText: '&& (and)' },
            { text: ' || ', displayText: '|| (or)' },
            { text: ' !', displayText: '! (not)' },
          ];

          window.loadRuleScript = function(src) {
            return new Promise((resolve, reject) => {
              let existing = document.querySelector('script[src="' + src + '"]');
              if (existing) {
                if (existing.dataset.loaded === '1') {
                  resolve();
                  return;
                }
                if (existing.dataset.failed === '1') {
                  existing.remove();
                  existing = null;
                }
              }

              if (existing) {
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', () => reject(new Error('Failed loading script: ' + src)), { once: true });
                return;
              }

              const script = document.createElement('script');
              script.src = src;
              script.async = true;
              script.onload = () => {
                script.dataset.loaded = '1';
                resolve();
              };
              script.onerror = () => {
                script.dataset.failed = '1';
                reject(new Error('Failed loading script: ' + src));
              };
              document.head.appendChild(script);
            });
          };

          window.ensureRuleAceCompleter = function(ace) {
            if (window.__ruleAceCompleterReady) return;
            const Range = ace.require('ace/range').Range;
            const langTools = ace.require('ace/ext/language_tools');
            langTools.addCompleter({
              getCompletions: function(editor, session, pos, prefix, callback) {
                const token = (prefix || '').toLowerCase();
                const matches = window.RULE_COMPLETIONS
                  .filter((item) => !token || item.displayText.toLowerCase().includes(token) || item.text.toLowerCase().includes(token))
                  .map((item, idx) => ({
                    caption: item.displayText,
                    value: item.text,
                    meta: 'rule',
                    score: 1000 - idx,
                  }));
                callback(null, matches);
              },
              insertMatch: function(editor, data) {
                const session = editor.getSession();
                const pos = editor.getCursorPosition();
                const line = session.getLine(pos.row) || '';
                if (pos.column > 0 && line.charAt(pos.column - 1) === '/') {
                  session.remove(new Range(pos.row, pos.column - 1, pos.row, pos.column));
                }
                const insertText = (data && (data.value || data.caption || data.snippet)) || '';
                if (insertText) {
                  editor.insert(insertText);
                }
              },
            });
            window.__ruleAceCompleterReady = true;
          };

          window.applyRuleEditorState = function(textarea) {
            const editor = textarea._aceEditor;
            if (!editor) return;
            const isDisabled = textarea.disabled;
            editor.setReadOnly(isDisabled);
            editor.container.classList.toggle('opacity-60', isDisabled);
            editor.container.style.pointerEvents = isDisabled ? 'none' : 'auto';
            editor.container.style.cursor = isDisabled ? 'not-allowed' : 'text';
            editor.container.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
            const cursorLayer = editor.renderer?.$cursorLayer?.element;
            if (cursorLayer) {
              cursorLayer.style.display = isDisabled ? 'none' : 'block';
            }
            if (isDisabled && typeof editor.blur === 'function') {
              editor.blur();
            }
          };

          window.initializeRuleEditors = async function(root) {
            try {
              await window.loadRuleScript('https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.0/ace.min.js');
              await window.loadRuleScript('https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.0/ext-language_tools.min.js');
            } catch (err) {
              if (typeof showToast === 'function') {
                showToast('Failed to load rule autocomplete library (Ace).', 'error');
              }
              return;
            }

            const ace = window.ace;
            if (!ace) return;
            window.ensureRuleAceCompleter(ace);

            root.querySelectorAll('.rule-input').forEach((textarea) => {
              if (textarea._aceEditor) {
                window.applyRuleEditorState(textarea);
                return;
              }

              const editorEl = document.createElement('div');
              editorEl.className = 'w-full border border-input rounded-md bg-background text-sm font-mono';
              editorEl.style.minHeight = textarea.classList.contains('h-24') ? '96px' : '80px';
              editorEl.style.padding = '8px 10px';
              editorEl.style.lineHeight = '1.45';

              textarea.style.display = 'none';
              textarea.insertAdjacentElement('afterend', editorEl);

              const editor = ace.edit(editorEl);
              editor.session.setMode('ace/mode/text');
              editor.session.setValue(textarea.value || '');
              editor.session.setUseWrapMode(true);
              editor.setShowPrintMargin(false);
              editor.setOption('highlightActiveLine', false);
              editor.setOption('showLineNumbers', false);
              editor.setOption('showGutter', false);
              editor.setOptions({
                fontSize: '13px',
                enableBasicAutocompletion: true,
                enableLiveAutocompletion: false,
              });

              editor.commands.addCommand({
                name: 'manualAutocomplete',
                bindKey: { win: 'Ctrl-Space', mac: 'Command-Space' },
                exec: function(ed) {
                  ed.execCommand('startAutocomplete');
                },
              });

              editor.on('change', function() {
                textarea.value = editor.getValue();
                if (typeof window.__updateCollectionSettingsDirtyState === 'function') {
                  window.__updateCollectionSettingsDirtyState();
                }
              });
              editor.commands.on('afterExec', function(e) {
                if (textarea.disabled) return;
                if (e.command && e.command.name === 'insertstring' && e.args === '/') {
                  const pos = editor.getCursorPosition();
                  const session = editor.getSession();
                  if (pos.column > 0) {
                    const Range = ace.require('ace/range').Range;
                    session.remove(new Range(pos.row, pos.column - 1, pos.row, pos.column));
                  }
                  editor.execCommand('startAutocomplete');
                }
              });

              textarea._aceEditor = editor;
              window.applyRuleEditorState(textarea);
            });
          };
        }

        window.initializeRuleEditors(document);
        setTimeout(() => window.initializeRuleEditors(document), 0);

        // Toggle rule lock/unlock for settings
        window.toggleRuleLock = async function(btn) {
          const container = btn.closest('.rule-container');
          const textarea = container?.querySelector('.rule-input');
          if (!textarea) return;
          let editor = textarea._aceEditor;
          
          const isLocked = btn.dataset.locked === 'true';
          
          if (isLocked) {
            // Unlock
            textarea.disabled = false;
            textarea.placeholder = 'Write your rule here...';
            btn.dataset.locked = 'false';
            btn.innerHTML = '<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10h12V7c0-.551.449-1 1-1s1 .449 1 1v3h1c.551 0 1 .449 1 1v10c0 .551-.449 1-1 1H6c-.551 0-1-.449-1-1V11c0-.551.449-1 1-1h1V7c0-3.866 3.134-7 7-7s7 3.134 7 7v2c0 .551-.449 1-1 1s-1-.449-1-1V7c0-2.757-2.243-5-5-5s-5 2.243-5 5v3z"></path></svg>';
            await window.initializeRuleEditors(container || document);
            editor = textarea._aceEditor;
            window.applyRuleEditorState(textarea);
            if (editor) {
              editor.focus();
            } else {
              textarea.focus();
            }
            if (typeof window.__updateCollectionSettingsDirtyState === 'function') {
              window.__updateCollectionSettingsDirtyState();
            }
          } else {
            // Lock
            textarea.disabled = true;
            textarea.placeholder = 'Admin only - click lock icon to edit';
            textarea.value = '';
            if (editor) editor.session.setValue('');
            btn.dataset.locked = 'true';
            btn.innerHTML = '<svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1m0 20c-4.975 0-9-4.025-9-9s4.025-9 9-9 9 4.025 9 9-4.025 9-9 9m3.5-9c0 1.933-1.567 3.5-3.5 3.5S8.5 13.933 8.5 12 10.067 8.5 12 8.5s3.5 1.567 3.5 3.5"></path></svg>';
            window.applyRuleEditorState(textarea);
            if (typeof window.__updateCollectionSettingsDirtyState === 'function') {
              window.__updateCollectionSettingsDirtyState();
            }
          }
        };

        (function () {
        const settingsForm = document.getElementById('collection-settings-form');
        const saveSettingsBtn = document.getElementById('save-settings-btn');
        let initialSettingsFingerprint = '';

        function collectSettingsFingerprint() {
          if (!settingsForm) return '';

          const collectionNameInput = settingsForm.querySelector('input[name="name"]');
          const viewQueryInput = settingsForm.querySelector('textarea[name="view_query"]');
          const googleEnabledInput = settingsForm.querySelector('input[name="google_enabled"]');

          const rules = Array.from(settingsForm.querySelectorAll('textarea[name$="_rule"]'))
            .map((el) => ({
              name: el.getAttribute('name') || '',
              value: el.value || '',
              disabled: !!el.disabled,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

          const schemaRows = Array.from(document.querySelectorAll('#schema-fields-container .schema-row')).map((row) => {
            const isSystem = row.dataset.system === 'true';
            if (isSystem) {
              return {
                original: row.dataset.original || '',
                system: true,
              };
            }

            return {
              original: row.dataset.original || '',
              isNew: row.dataset.isNew === 'true',
              name: row.querySelector('.schema-name')?.value || '',
              type: row.querySelector('.schema-type')?.value || '',
              required: !!row.querySelector('.schema-required')?.checked,
              nonzero: !!row.querySelector('.schema-nonzero')?.checked,
              min: row.querySelector('.schema-min')?.value || '',
              max: row.querySelector('.schema-max')?.value || '',
              regex: row.querySelector('.schema-regex')?.value || '',
              trim_input: !!row.querySelector('.schema-trim-input')?.checked,
            };
          });

          const indexes = Array.from(document.querySelectorAll('#indexes-list .bg-card')).map((row) => ({
            fields: row.querySelector('.index-fields')?.value || '',
            type: row.querySelector('.index-type')?.value || 'index',
          }));

          return JSON.stringify({
            name: collectionNameInput?.value || '',
            viewQuery: viewQueryInput?.value || '',
            googleEnabled: !!googleEnabledInput?.checked,
            rules,
            schemaRows,
            indexes,
          });
        }

        function updateSaveSettingsState() {
          if (!saveSettingsBtn) return;
          const currentFingerprint = collectSettingsFingerprint();
          saveSettingsBtn.disabled = currentFingerprint === initialSettingsFingerprint;
        }

        function primeSaveSettingsState() {
          initialSettingsFingerprint = collectSettingsFingerprint();
          updateSaveSettingsState();
        }

        window.__updateCollectionSettingsDirtyState = updateSaveSettingsState;

        if (settingsForm) {
          settingsForm.addEventListener('input', updateSaveSettingsState);
          settingsForm.addEventListener('change', updateSaveSettingsState);
          settingsForm.addEventListener('click', function() {
            setTimeout(updateSaveSettingsState, 0);
          });
        }

        const rawExistingSchema = ${JSON.stringify(col.schema || [])};
        const existingSchema = (() => {
          const rows = [];
          if (
            rawExistingSchema &&
            typeof rawExistingSchema === 'object' &&
            Array.isArray(rawExistingSchema.fields)
          ) {
            rawExistingSchema.fields.forEach((item) => {
              if (!item || typeof item !== 'object') return;
              const name = (item.name || '').toString().trim();
              if (!name) return;
              rows.push({ ...item, name, type: item.type || 'text' });
            });
            return rows;
          }

          if (Array.isArray(rawExistingSchema)) {
            rawExistingSchema.forEach((item) => {
              if (!item || typeof item !== 'object') return;
              const name = (item.name || '').toString().trim();
              if (!name) return;
              rows.push({ ...item, name, type: item.type || 'text' });
            });
            return rows;
          }

          if (rawExistingSchema && typeof rawExistingSchema === 'object') {
            Object.entries(rawExistingSchema).forEach(([key, value]) => {
              if (value && typeof value === 'object') {
                const name = (value.name || key || '').toString().trim();
                if (!name) return;
                rows.push({ ...value, name, type: value.type || 'text' });
                return;
              }
              const name = (key || '').toString().trim();
              if (!name) return;
              rows.push({ name, type: 'text', system: false, required: false });
            });
          }
          return rows;
        })();
        const SYSTEM_FIELD_NAMES = new Set([
          'id',
          'created',
          'updated',
          'created_at',
          'updated_at',
          'password_hash',
          'token_key',
          'verified',
          'email',
          'username',
        ]);
        const visibleSchema = existingSchema.filter((s) => {
          const name = String(s?.name || '').toLowerCase();
          return !s?.system && !SYSTEM_FIELD_NAMES.has(name);
        });
        const preservedSystemSchema = existingSchema.filter((s) => {
          const name = String(s?.name || '').toLowerCase();
          return !!s?.system || SYSTEM_FIELD_NAMES.has(name);
        });
        const existingMultiIndexes = ${col.type !== "view" ? existingIndexes : "[]"};
        const viewTypes = ['text', 'number', 'boolean', 'email', 'url', 'date', 'date_only', 'richtext', 'json', 'file', 'relation'];

        function renderSettingsRow(s, isNew = false) {
           const id = 'sf_' + Math.random().toString(36).substr(2, 9);
           const typeOpts = viewTypes.map(t => \`<option value="\${t}" \${t === s.type ? 'selected' : ''}>\${t}</option>\`).join('');
           return \`
            <div id="\${id}" class="schema-row border border-border bg-card rounded-md mb-2 flex flex-col group overflow-hidden" data-is-new="\${isNew}" data-original="\${s.name || ''}" data-system="\${s.system || false}">
              <div class="p-3 flex gap-3 items-center w-full">
               \${s.system ? 
                 \`<div class="flex-1 px-2 text-sm font-mono text-muted-foreground">\${s.name} (system)</div>\` : 
                 \`<div class="flex-1 flex gap-2">
                    <input type="text" class="schema-name flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value="\${s.name || ''}" placeholder="Field name" required>
                    <select class="schema-type flex h-9 w-32 rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring \${!isNew && s.type ? "opacity-50" : ""}" \${!isNew && s.type ? "disabled" : ""} onchange="updateSettingsRowDisplay('\${id}')">
                       \${typeOpts}
                    </select>
                 </div>
                 <div class="w-16 items-center flex justify-end gap-1">
                   <button type="button" onclick="toggleFieldSettings('\${id}')" class="p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground rounded transition" title="Field Settings">
                     <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                   </button>
                   <button type="button" onclick="document.getElementById('\${id}').remove()" class="p-1.5 text-red-500/70 hover:bg-red-50 hover:text-red-600 rounded transition" title="Remove field">
                     <span class="text-sm font-bold">🗑️</span>
                   </button>
                 </div>
                 \`
               }
              </div>
            
            \${!s.system ? \`
            <div class="field-settings hidden bg-muted/20 border-t border-border p-4 space-y-4">
              <div class="flex gap-4">
                 <label class="flex items-center space-x-2 text-sm font-medium cursor-pointer">
                   <input type="checkbox" class="schema-required h-4 w-4 rounded border-input" \${s.required ? "checked" : ""}> <span>Required</span>
                 </label>
              </div>
              
              <div class="schema-number-settings flex items-center space-x-4">
                 <label class="flex items-center space-x-2 text-sm font-medium cursor-pointer">
                   <input type="checkbox" class="schema-nonzero h-4 w-4 rounded border-input" \${s.nonzero ? "checked" : ""}> <span>Non-Zero</span>
                 </label>
                 <div class="flex gap-2">
                    <input type="number" class="schema-min flex h-9 w-24 rounded border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Min" value="\${s.min || ''}">
                    <input type="number" class="schema-max flex h-9 w-24 rounded border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Max" value="\${s.max || ''}">
                 </div>
              </div>
              
              <div class="schema-text-settings">
                 <input type="text" class="schema-regex flex h-9 w-full rounded border border-input bg-background px-3 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono" placeholder="Regex validation pattern" value="\${s.regex || ''}">
                 <div class="mt-3 flex items-center space-x-2 schema-trim-wrapper hidden">
                   <input type="checkbox" class="schema-trim-input h-4 w-4 rounded border-input" \${s.trim_input ? "checked" : ""}>
                   <span class="text-sm font-medium">Trim Input</span>
                 </div>
              </div>
            </div>
            \` : ''}

            </div>
           \`;
        }

        window.toggleFieldSettings = function(id) {
           const row = document.getElementById(id);
           const settings = row.querySelector('.field-settings');
           if (settings) {
              settings.classList.toggle('hidden');
              // Ensure correct display logic when toggled on
              updateSettingsRowDisplay(id);
           }
        };

        window.updateSettingsRowDisplay = function(id) {
           const row = document.getElementById(id);
           if(!row) return;
           const typeSelect = row.querySelector('.schema-type');
           const numSettings = row.querySelector('.schema-number-settings');
           const textSettings = row.querySelector('.schema-text-settings');
           const trimWrapper = row.querySelector('.schema-trim-wrapper');
           if(!typeSelect || !numSettings || !textSettings) return;

           const type = typeSelect.value;
           numSettings.style.display = type === 'number' ? 'flex' : 'none';
           textSettings.style.display = type === 'text' || type === 'richtext' ? 'block' : 'none';
           if (trimWrapper) {
             trimWrapper.style.display = type === 'text' || type === 'richtext' ? 'flex' : 'none';
           }
        };

        window.addIndex = function() {
          const id = "idx_" + Math.random().toString(36).substr(2, 9);
          const html = \`<div class="bg-card w-full border border-border rounded-md shadow-sm p-4 pt-3 flex flex-col group relative" id="\${id}">
            <div class="flex items-center gap-3">
              <div class="flex-1">
                <input type="text" class="index-fields flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono" placeholder="Comma-separated fields, e.g., user_id, status" required>
              </div>
              <div class="w-32">
                <select class="index-type flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="index">Index</option>
                  <option value="unique">Unique</option>
                </select>
              </div>
              <button type="button" onclick="document.getElementById('\${id}').remove()" class="p-2 text-red-500/70 hover:bg-red-50 hover:text-red-600 rounded transition" title="Remove index">
                 <span class="text-xs font-bold">🗑️</span>
              </button>
            </div>
          </div>\`;
          document.getElementById('indexes-list').insertAdjacentHTML('beforeend', html);
          if (typeof window.__updateCollectionSettingsDirtyState === 'function') {
            window.__updateCollectionSettingsDirtyState();
          }
        };

        function mountSettingsSchema() {
           const container = document.getElementById('schema-fields-container');
           if(!container) return;
           container.innerHTML = visibleSchema.map(s => renderSettingsRow(s, false)).join('');
           
           // Initialize displays
           // let's grab all rows and update them
           container.querySelectorAll('.schema-row').forEach(row => {
               updateSettingsRowDisplay(row.id);
           });
           
           if(existingMultiIndexes && existingMultiIndexes.length > 0) {
             existingMultiIndexes.forEach(idx => {
                const id = "idx_" + Math.random().toString(36).substr(2, 9);
                const html = \`<div class="bg-card w-full border border-border rounded-md shadow-sm p-4 pt-3 flex flex-col group relative" id="\${id}">
                  <div class="flex items-center gap-3">
                    <div class="flex-1">
                      <input type="text" class="index-fields flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring font-mono" value="\${idx.fields}" placeholder="Comma-separated fields, e.g., user_id, status" required>
                    </div>
                    <div class="w-32">
                      <select class="index-type flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <option value="index" \${idx.type === 'index' ? 'selected' : ''}>Index</option>
                        <option value="unique" \${idx.type === 'unique' ? 'selected' : ''}>Unique</option>
                      </select>
                    </div>
                    <button type="button" onclick="document.getElementById('\${id}').remove()" class="p-2 text-red-500/70 hover:bg-red-50 hover:text-red-600 rounded transition" title="Remove index">
                       <span class="text-xs font-bold">🗑️</span>
                    </button>
                  </div>
                </div>\`;
                document.getElementById('indexes-list').insertAdjacentHTML('beforeend', html);
             });
           }
        }

        window.addNewFieldRow = function() {
           const container = document.getElementById('schema-fields-container');
           if(!container) return;
           container.insertAdjacentHTML('beforeend', renderSettingsRow({type: 'text'}, true));
            if (typeof window.__updateCollectionSettingsDirtyState === 'function') {
             window.__updateCollectionSettingsDirtyState();
            }
        }

        window.syncSchemaPayload = function() {
           const rows = document.querySelectorAll('.schema-row');
           const data = [];
           rows.forEach(r => {
             const nameEl = r.querySelector('.schema-name');
             const typeEl = r.querySelector('.schema-type');
             if(!nameEl || !nameEl.value.trim()) return;

             const sf = {
                 originalName: r.dataset.original || '',
                 name: nameEl.value.trim().toLowerCase().replace(/\\s+/g, "_"),
                 type: typeEl ? typeEl.value : 'text',
                 isNew: r.dataset.isNew === 'true',
                 required: r.querySelector('.schema-required')?.checked || false,
                 system: false
             };
             
             if (sf.type === 'number') {
                 sf.nonzero = r.querySelector('.schema-nonzero')?.checked || false;
                 sf.min = r.querySelector('.schema-min')?.value || '';
                 sf.max = r.querySelector('.schema-max')?.value || '';
             } else if (sf.type === 'text') {
                 sf.regex = r.querySelector('.schema-regex')?.value || '';
               sf.trim_input = r.querySelector('.schema-trim-input')?.checked || false;
             } else if (sf.type === 'richtext') {
               sf.trim_input = r.querySelector('.schema-trim-input')?.checked || false;
             }

             data.push(sf);
           });

           // Preserve system/internal schema entries even though they are hidden in UI.
           preservedSystemSchema.forEach((sf) => data.push(sf));
           document.getElementById('schema_payload').value = JSON.stringify(data);
        }
        
        if (window.__settingsConfigRequestHandler) {
          document.body.removeEventListener('htmx:configRequest', window.__settingsConfigRequestHandler);
        }

        window.__settingsConfigRequestHandler = function(e) {
          if (e.target.tagName === 'FORM' && e.target.getAttribute('hx-post')?.includes('/settings')) {
             syncSchemaPayload();
             
             const indexEls = document.querySelectorAll('#indexes-list .bg-card');
             if(indexEls.length > 0) {
               const indexesArr = [];
               indexEls.forEach(function(el) {
                  indexesArr.push({
                     fields: el.querySelector('.index-fields').value,
                     type: el.querySelector('.index-type').value
                  });
               });
               e.detail.parameters.indexes = JSON.stringify(indexesArr);
             }
          }
        };

        document.body.addEventListener('htmx:configRequest', window.__settingsConfigRequestHandler);

        setTimeout(function() {
          mountSettingsSchema();
          primeSaveSettingsState();
        }, 0);
        })();
      </script>
    `);
  } catch (err: any) {
    console.error("Record save error:", err);
    return c.html(
      `<div class="text-red-500 p-4">Error: Internal server error</div>`,
      500,
    );
  }
});

collections.post("/:collection/settings", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  const body = await c.req.parseBody();
  try {
    const rawName = (body.name as string) || collectionName;
    const targetCollectionName = rawName
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (
      !targetCollectionName ||
      !/^[a-zA-Z0-9_]+$/.test(targetCollectionName)
    ) {
      throw new Error("Invalid collection name.");
    }
    if (targetCollectionName.startsWith("_")) {
      throw new Error(
        "Collection names cannot start with an underscore (reserved for system).",
      );
    }

    const currentMeta =
      await sql`SELECT type, schema, oauth2 FROM _collections WHERE name = ${collectionName}`;
    if (currentMeta.length === 0) throw new Error("Collection not found");

    if (targetCollectionName !== collectionName) {
      const existing =
        await sql`SELECT name FROM _collections WHERE name = ${targetCollectionName} LIMIT 1`;
      if (existing.length > 0) {
        throw new Error(`Collection '${targetCollectionName}' already exists.`);
      }
    }

    let isView = currentMeta[0].type === "view";
    let newSchema = [];
    const viewQuery = ((body.view_query as string) || "").trim();

    if (isView && !viewQuery) {
      throw new Error("View Collection requires a SELECT query.");
    }

    if (!isView && body.schema_payload) {
      const schemaPayloadRaw =
        typeof body.schema_payload === "string"
          ? body.schema_payload
          : String(body.schema_payload || "");
      if (schemaPayloadRaw.trim()) {
        newSchema = JSON.parse(schemaPayloadRaw);
      }

      const cleanUserFields = newSchema.filter((field: any) => !field.system);
      if (currentMeta[0].type === "base" && cleanUserFields.length === 0) {
        throw new Error("Base Collection must have at least one custom field.");
      }

      let oldSchema =
        typeof currentMeta[0].schema === "string"
          ? JSON.parse(currentMeta[0].schema)
          : currentMeta[0].schema || [];

      // Compute deleted fields
      const newNames = newSchema.map((s: any) => s.originalName || s.name);
      const deletedFields = oldSchema.filter(
        (os: any) => !os.system && !newNames.includes(os.name),
      );

      for (const df of deletedFields) {
        await sql.unsafe(
          `ALTER TABLE "${collectionName}" DROP COLUMN "${df.name}" CASCADE`,
        );
      }

      // Compute added and renamed fields
      for (let ns of newSchema) {
        if (ns.system) continue;
        if (ns.isNew) {
          let safeType = "TEXT";
          switch (ns.type) {
            case "number":
              safeType = "NUMERIC";
              break;
            case "boolean":
              safeType = "BOOLEAN";
              break;
            case "date":
              safeType = "TIMESTAMP WITH TIME ZONE";
              break;
            case "date_only":
              safeType = "VARCHAR(10)";
              break;
            case "json":
              safeType = "JSONB";
              break;
            case "relation":
              safeType = "UUID";
              break;
          }
          await sql.unsafe(
            `ALTER TABLE "${collectionName}" ADD COLUMN "${ns.name}" ${safeType}`,
          );

          await syncFieldSqlConstraints(collectionName, ns, ns.name);

          delete ns.isNew;
          delete ns.originalName;
        } else {
          // Existing field logic
          const oldField = oldSchema.find(
            (os: any) => os.name === ns.originalName,
          );

          if (ns.originalName && ns.originalName !== ns.name) {
            await sql.unsafe(
              `ALTER TABLE "${collectionName}" RENAME COLUMN "${ns.originalName}" TO "${ns.name}"`,
            );
          }

          await syncFieldSqlConstraints(
            collectionName,
            ns,
            oldField?.name || ns.originalName,
          );

          delete ns.originalName;
        }
      }

      // Process Index Array similarly to Creation
      if (body.indexes) {
        const indexesRaw =
          typeof body.indexes === "string"
            ? body.indexes
            : String(body.indexes || "");
        const customIndexes = indexesRaw.trim() ? JSON.parse(indexesRaw) : [];
        for (const idx of customIndexes) {
          if (!idx.fields) continue;
          const columns = idx.fields
            .split(",")
            .map((f: string) => f.trim().toLowerCase().replace(/\s+/g, "_"))
            .filter(Boolean);
          if (columns.length === 0) continue;
          const indexName = `idx_${collectionName}_${columns.join("_")}`;

          if (idx.type === "unique") {
            try {
              await sql.unsafe(
                `ALTER TABLE "${collectionName}" ADD CONSTRAINT "uq_${indexName}" UNIQUE ("${columns.join('", "')}")`,
              );
            } catch (e) {} // Ignore if already exists
          } else {
            await sql.unsafe(
              `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${collectionName}" ("${columns.join('", "')}")`,
            );
          }
        }
      }
    }

    let existingOauth2: any = {};
    try {
      existingOauth2 =
        typeof currentMeta[0].oauth2 === "string"
          ? JSON.parse(currentMeta[0].oauth2)
          : currentMeta[0].oauth2 || {};
    } catch (e) {
      existingOauth2 = {};
    }

    const mergedOauth2 = {
      ...existingOauth2,
      google_enabled: body.google_enabled === "true",
    };

    if (targetCollectionName !== collectionName) {
      if (isView) {
        assertReadOnlySqlQuery(viewQuery);
        await sql.unsafe(
          `ALTER VIEW "${collectionName}" RENAME TO "${targetCollectionName}"`,
        );
      } else {
        await sql.unsafe(
          `ALTER TABLE "${collectionName}" RENAME TO "${targetCollectionName}"`,
        );
      }
    }

    if (isView) {
      assertReadOnlySqlQuery(viewQuery);
      await sql.unsafe(
        `CREATE OR REPLACE VIEW "${targetCollectionName}" AS ${viewQuery}`,
      );
    }

    const schemaAssignment =
      !isView && body.schema_payload
        ? sql`${JSON.stringify(newSchema)}::jsonb`
        : sql`schema`;

    await sql`
      UPDATE _collections 
      SET 
        name = ${targetCollectionName},
        view_query = ${isView ? viewQuery : sql`view_query`},
        list_rule = ${(body.list_rule as string) || null},
        view_rule = ${(body.view_rule as string) || null},
        create_rule = ${(body.create_rule as string) || null},
        update_rule = ${(body.update_rule as string) || null},
        delete_rule = ${(body.delete_rule as string) || null},
        schema = ${schemaAssignment},
        updated_at = NOW(),
        oauth2 = ${JSON.stringify(mergedOauth2)}::jsonb
      WHERE name = ${collectionName}
    `;

    if (targetCollectionName !== collectionName) {
      c.header(
        "HX-Push-Url",
        `/collections/${encodeURIComponent(targetCollectionName)}`,
      );
    }

    return c.html(`
      <script>
        showToast("Collection '${targetCollectionName}' saved successfully.", "success");
        setTimeout(() => {
          htmx.ajax('GET', '${collectionsBase}', '#collections-list');
          htmx.ajax('GET', '${collectionsBase}/${targetCollectionName}/settings', '#drawer-container');
          htmx.ajax('GET', '${collectionsBase}/${targetCollectionName}/records', '#main-content');
        }, 10);
      </script>
    `);
  } catch (err: any) {
    const errMsg =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message;
    return htmxErrorResponse(`Error saving settings: ${errMsg}`);
  }
});

collections.delete("/:collection", async (c) => {
  const collectionsBase = getCollectionsBasePath(c);
  const collectionName = c.req.param("collection");
  try {
    const meta =
      await sql`SELECT type FROM _collections WHERE name = ${collectionName} LIMIT 1`;
    if (meta.length === 0)
      return c.html(
        `<div class="text-red-500 p-4">Collection not found!</div>`,
      );

    // Only drop physical tables for base or auth types
    if (meta[0].type !== "view") {
      await sql.unsafe(
        `DROP TABLE IF EXISTS ${quoteIdentifier(collectionName)} CASCADE`,
      );
    } else {
      await sql.unsafe(
        `DROP VIEW IF EXISTS ${quoteIdentifier(collectionName)} CASCADE`,
      );
    }

    await sql`DELETE FROM _collections WHERE name = ${collectionName}`;

    c.header("HX-Push-Url", "/collections");
    const placeholderHTML = `
          <div class="flex flex-col items-center justify-center h-full text-center text-muted-foreground/70">
            <svg
              class="w-16 h-16 mb-4 text-gray-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
              ></path>
            </svg>
            <p class="text-lg font-medium">No Collection Selected</p>
            <p class="text-sm mt-1">
              Choose a collection to manage its schema and records.
            </p>
          </div>
        `;
    return c.html(`
      <script>
        showToast("Collection '${collectionName}' has been permanently deleted.", "success");
        htmx.ajax('GET', '${collectionsBase}', '#collections-list');
        document.getElementById('main-content').innerHTML = ${JSON.stringify(placeholderHTML)};
        if (window.closeDrawer) window.closeDrawer();
      </script>
    `);
  } catch (err: any) {
    console.error("Delete collection error:", err);
    return c.html(
      `<div class="text-red-500 p-4">Error deleting collection: Internal server error</div>`,
      500,
    );
  }
});

export default collections;
