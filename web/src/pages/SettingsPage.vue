<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  Copy,
  DatabaseBackup,
  Download,
  Gauge,
  Heart,
  Loader2,
  Play,
  Settings2,
  Upload,
  X,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/lib/api";
import { useCollectionsStore } from "@/stores/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Same curated list as the legacy settings page (COMMON_TIMEZONES).
const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Warsaw",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// Same options as the legacy settings page (PG_BACKUP_FREQUENCIES).
const BACKUP_FREQUENCIES = ["30m", "1h", "12h", "daily", "weekly", "monthly"];

// Same base suggestions as the legacy rate limiter UI.
const RL_SUGGESTIONS_BASE = [
  "/api/collections/*/auth-with-password",
  "/api/collections/*/auth-with-oauth2/*",
  "/api/collections/*/auth-refresh",
  "/api/collections/*/request-verification",
  "/api/collections/*/confirm-verification",
  "/api/collections/*/request-password-reset",
  "/api/collections/*/confirm-password-reset",
  "/api/collections/*/request-email-change",
  "/api/collections/*/confirm-email-change",
  "/api/collections/*/records",
  "/api/collections/*/records/*",
  "/api/collections/*",
  "/api/*",
  "/internal/api/auth/login",
  "/internal/api/auth/setup",
];

interface RateRule {
  label: string;
  pattern: string;
  maxRequests: number;
  intervalSeconds: number;
  targetedUsers: "all" | "guest" | "auth";
}

interface SystemData {
  timezone: string;
  customEndpointsEnabled: boolean;
  googleOAuth: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
  };
  rateLimiting: { enabled: boolean; rules: RateRule[] };
}

interface BackupEntry {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

interface BackupsData {
  settings: {
    enabled: boolean;
    frequency: string;
    retainCount: number;
    lastRunAt: string | null;
  };
  backups: BackupEntry[];
}

interface ImportResult {
  created: string[];
  skipped: string[];
  errors: { name: string; error: string }[];
}

const store = useCollectionsStore();

const tabs = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "api-providers", label: "API Providers", icon: Heart },
  { id: "rate-limiter", label: "Rate Limiter", icon: Gauge },
  { id: "import-export", label: "Import / Export", icon: Upload },
  { id: "backups", label: "Backups", icon: DatabaseBackup },
] as const;

type TabId = (typeof tabs)[number]["id"];
const activeTab = ref<TabId>("general");

const loadingSystem = ref(true);
const system = ref<SystemData | null>(null);

// General
const timezone = ref("UTC");
const initialTimezone = ref("UTC");
const savingTimezone = ref(false);
const customEndpointsEnabled = ref(false);
const initialCustomEndpointsEnabled = ref(false);
const savingCustomEndpoints = ref(false);

// Google OAuth
const googleEnabled = ref(false);
const googleClientId = ref("");
const googleClientSecret = ref("");
const googleRedirectUrl = ref("/api/collections/auth-with-oauth2/google/callback");
const savingGoogle = ref(false);

// Rate limiter
const rateLimitEnabled = ref(false);
const rateRules = reactive<RateRule[]>([]);
const savingRateLimit = ref(false);
const patternSuggestions = ref<string[]>([...RL_SUGGESTIONS_BASE]);

// Import / export
const importFileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importResult = ref<ImportResult | null>(null);

// Backups
const backupsLoaded = ref(false);
const loadingBackups = ref(false);
const backupEnabled = ref(false);
const backupFrequency = ref("daily");
const backupRetainCount = ref(5);
const backupLastRunAt = ref<string | null>(null);
const backups = ref<BackupEntry[]>([]);
const savingBackupSettings = ref(false);
const runningBackup = ref(false);
const restoreTarget = ref<string | null>(null);
const restoring = ref(false);

function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

async function loadSystem() {
  loadingSystem.value = true;
  try {
    const data = await api.get<SystemData>("/internal/api/admin/system");
    system.value = data;
    timezone.value = data.timezone;
    initialTimezone.value = data.timezone;
    customEndpointsEnabled.value = data.customEndpointsEnabled;
    initialCustomEndpointsEnabled.value = data.customEndpointsEnabled;
    googleEnabled.value = data.googleOAuth.enabled;
    googleClientId.value = data.googleOAuth.clientId;
    googleClientSecret.value = data.googleOAuth.clientSecret;
    googleRedirectUrl.value = data.googleOAuth.redirectUrl;
    rateLimitEnabled.value = data.rateLimiting.enabled;
    rateRules.splice(
      0,
      rateRules.length,
      ...data.rateLimiting.rules.map((r) => ({ ...r })),
    );
  } catch (err) {
    toast.error(errorMessage(err, "Failed to load system settings."));
  } finally {
    loadingSystem.value = false;
  }
}

async function loadPatternSuggestions() {
  try {
    const data = await api.get<{ routes: { method: string; path: string }[] }>(
      "/internal/api/admin/custom-endpoints",
    );
    const merged = [...RL_SUGGESTIONS_BASE];
    for (const route of data.routes || []) {
      if (route?.path && !merged.includes(route.path)) merged.push(route.path);
    }
    patternSuggestions.value = merged;
  } catch {
    // Fallback to the base list.
  }
}

async function saveTimezone() {
  savingTimezone.value = true;
  try {
    const data = await api.post<{ ok: boolean; timezone: string }>(
      "/internal/api/admin/system/timezone",
      { timezone: timezone.value },
    );
    timezone.value = data.timezone;
    initialTimezone.value = data.timezone;
    toast.success("Timezone saved.");
  } catch (err) {
    toast.error(errorMessage(err, "Failed to save timezone."));
  } finally {
    savingTimezone.value = false;
  }
}

async function saveCustomEndpoints() {
  savingCustomEndpoints.value = true;
  try {
    const data = await api.post<{ ok: boolean; enabled: boolean }>(
      "/internal/api/admin/system/custom-endpoints",
      { enabled: customEndpointsEnabled.value },
    );
    customEndpointsEnabled.value = data.enabled;
    initialCustomEndpointsEnabled.value = data.enabled;
    toast.success(data.enabled ? "Custom endpoints enabled." : "Custom endpoints disabled.");
  } catch (err) {
    toast.error(errorMessage(err, "Failed to save setting."));
  } finally {
    savingCustomEndpoints.value = false;
  }
}

async function saveGoogle() {
  savingGoogle.value = true;
  try {
    await api.post("/internal/api/admin/system/google-oauth", {
      enabled: googleEnabled.value,
      clientId: googleClientId.value,
      clientSecret: googleClientSecret.value,
    });
    toast.success("Google OAuth settings saved.");
  } catch (err) {
    toast.error(errorMessage(err, "Failed to save Google OAuth settings."));
  } finally {
    savingGoogle.value = false;
  }
}

async function copyRedirectUrl() {
  try {
    await navigator.clipboard.writeText(googleRedirectUrl.value);
    toast.success("Callback URL copied.");
  } catch {
    toast.error("Failed to copy to clipboard.");
  }
}

function addRateRule() {
  rateRules.push({
    label: "",
    pattern: "",
    maxRequests: 10,
    intervalSeconds: 60,
    targetedUsers: "all",
  });
}

function removeRateRule(idx: number) {
  rateRules.splice(idx, 1);
}

async function saveRateLimit() {
  savingRateLimit.value = true;
  try {
    await api.post("/internal/api/admin/system/rate-limiting", {
      enabled: rateLimitEnabled.value,
      rules: rateRules.map((r) => ({
        label: r.label || r.pattern,
        pattern: r.pattern,
        maxRequests: r.maxRequests,
        intervalSeconds: r.intervalSeconds,
        targetedUsers: r.targetedUsers,
      })),
    });
    toast.success("Rate limiting settings saved.");
  } catch (err) {
    toast.error(errorMessage(err, "Failed to save rate limiting settings."));
  } finally {
    savingRateLimit.value = false;
  }
}

function triggerImportPicker() {
  importResult.value = null;
  importFileInput.value?.click();
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  let parsed: unknown;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch {
    toast.error("The selected file is not valid JSON.");
    return;
  }

  const collections = Array.isArray(parsed)
    ? parsed
    : (parsed as { collections?: unknown })?.collections;
  if (!Array.isArray(collections)) {
    toast.error("Invalid export file: expected a collections array.");
    return;
  }

  importing.value = true;
  importResult.value = null;
  try {
    const result = await api.post<ImportResult>("/internal/api/admin/import", {
      collections,
    });
    importResult.value = result;
    if (result.errors.length === 0) {
      toast.success(
        `Import finished: ${result.created.length} created, ${result.skipped.length} skipped.`,
      );
    } else {
      toast.error(
        `Import finished with ${result.errors.length} error(s).`,
      );
    }
    await store.refresh();
  } catch (err) {
    toast.error(errorMessage(err, "Import failed."));
  } finally {
    importing.value = false;
  }
}

async function loadBackups() {
  loadingBackups.value = true;
  try {
    const data = await api.get<BackupsData>("/internal/api/admin/backups");
    backupEnabled.value = data.settings.enabled;
    backupFrequency.value = data.settings.frequency;
    backupRetainCount.value = data.settings.retainCount;
    backupLastRunAt.value = data.settings.lastRunAt;
    backups.value = data.backups;
    backupsLoaded.value = true;
  } catch (err) {
    toast.error(errorMessage(err, "Failed to load backups."));
  } finally {
    loadingBackups.value = false;
  }
}

async function saveBackupSettings() {
  savingBackupSettings.value = true;
  try {
    await api.post("/internal/api/admin/backups/settings", {
      enabled: backupEnabled.value,
      frequency: backupFrequency.value,
      retainCount: backupRetainCount.value,
    });
    toast.success("Backup settings saved.");
  } catch (err) {
    toast.error(errorMessage(err, "Failed to save backup settings."));
  } finally {
    savingBackupSettings.value = false;
  }
}

async function runBackupNow() {
  runningBackup.value = true;
  try {
    const data = await api.post<{ fileName: string }>(
      "/internal/api/admin/backups/run",
    );
    toast.success(`Backup created: ${data.fileName}`);
    await loadBackups();
  } catch (err) {
    toast.error(errorMessage(err, "Backup failed."));
  } finally {
    runningBackup.value = false;
  }
}

async function restoreBackup() {
  if (!restoreTarget.value) return;
  restoring.value = true;
  try {
    await api.post("/internal/api/admin/backups/restore", {
      filename: restoreTarget.value,
    });
    toast.success("Backup restored.");
    restoreTarget.value = null;
  } catch (err) {
    toast.error(errorMessage(err, "Restore failed."));
  } finally {
    restoring.value = false;
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

function formatDate(iso: string | null) {
  if (!iso) return "never";
  const date = new Date(iso);
  return isNaN(date.getTime()) ? iso : date.toLocaleString();
}

const googleDirty = computed(() => {
  if (!system.value) return false;
  return (
    googleEnabled.value !== system.value.googleOAuth.enabled ||
    googleClientId.value !== system.value.googleOAuth.clientId ||
    googleClientSecret.value !== system.value.googleOAuth.clientSecret
  );
});

watch(activeTab, (tab) => {
  if (tab === "backups" && !backupsLoaded.value && !loadingBackups.value) {
    loadBackups();
  }
});

onMounted(() => {
  loadSystem();
  loadPatternSuggestions();
});
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- Left nav -->
    <aside class="flex w-52 shrink-0 flex-col gap-0.5 border-r bg-card px-2 py-5">
      <div class="mb-2 border-b px-2 pb-3">
        <p class="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
          Settings
        </p>
        <h2 class="mt-0.5 text-lg font-semibold tracking-tight">System</h2>
      </div>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :data-settings-tab="tab.id"
        :class="[
          'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.8125rem] font-medium transition-colors',
          activeTab === tab.id
            ? 'bg-primary/10 font-semibold text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        ]"
        @click="activeTab = tab.id"
      >
        <component :is="tab.icon" class="h-3.5 w-3.5" />
        {{ tab.label }}
        <Badge
          v-if="tab.id === 'rate-limiter'"
          :variant="rateLimitEnabled ? 'default' : 'secondary'"
          class="ml-auto px-1.5 py-0 text-[0.65rem]"
        >
          {{ rateLimitEnabled ? "On" : "Off" }}
        </Badge>
        <Badge
          v-else-if="tab.id === 'backups'"
          :variant="backupEnabled ? 'default' : 'secondary'"
          class="ml-auto px-1.5 py-0 text-[0.65rem]"
        >
          {{ backupEnabled ? "On" : "Off" }}
        </Badge>
      </button>
    </aside>

    <!-- Right content -->
    <div class="min-w-0 flex-1 overflow-y-auto p-7">
      <div v-if="loadingSystem" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" />
        Loading settings…
      </div>

      <!-- ── GENERAL ── -->
      <div v-else-if="activeTab === 'general'" class="max-w-3xl space-y-5">
        <div class="border-b pb-4">
          <h3 class="text-base font-semibold">General</h3>
          <p class="mt-0.5 text-sm text-muted-foreground">
            Timezone and feature flags.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle class="text-sm">Timezone</CardTitle>
            <CardDescription>
              Controls how dates are displayed in the admin panel.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              class="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end"
              @submit.prevent="saveTimezone"
            >
              <div class="flex-1 space-y-1.5">
                <Label for="settings-timezone">Default Timezone</Label>
                <Select v-model="timezone">
                  <SelectTrigger id="settings-timezone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="tz in COMMON_TIMEZONES"
                      :key="tz"
                      :value="tz"
                    >
                      {{ tz }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="submit"
                :disabled="savingTimezone || timezone === initialTimezone"
              >
                <Loader2 v-if="savingTimezone" class="h-4 w-4 animate-spin" />
                Save Timezone
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div class="flex items-center justify-between">
              <CardTitle class="text-sm">Custom Endpoints</CardTitle>
              <Badge :variant="customEndpointsEnabled ? 'default' : 'secondary'">
                {{ customEndpointsEnabled ? "Enabled" : "Disabled" }}
              </Badge>
            </div>
            <CardDescription>
              Allow filesystem-backed scripts in
              <code class="rounded bg-muted px-1 text-xs">custom_endpoints/</code>
              to register routes and cron jobs.
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center gap-2">
              <Checkbox
                id="settings-ce-enabled"
                v-model="customEndpointsEnabled"
              />
              <Label for="settings-ce-enabled" class="font-normal">
                Enable Custom Endpoints
              </Label>
            </div>
            <Button
              :disabled="
                savingCustomEndpoints ||
                customEndpointsEnabled === initialCustomEndpointsEnabled
              "
              data-testid="ce-toggle-save"
              @click="saveCustomEndpoints"
            >
              <Loader2
                v-if="savingCustomEndpoints"
                class="h-4 w-4 animate-spin"
              />
              Save
            </Button>
          </CardContent>
        </Card>
      </div>

      <!-- ── API PROVIDERS ── -->
      <div v-else-if="activeTab === 'api-providers'" class="max-w-3xl space-y-5">
        <div class="border-b pb-4">
          <h3 class="text-base font-semibold">API Providers</h3>
          <p class="mt-0.5 text-sm text-muted-foreground">
            Third-party OAuth and authentication providers.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div class="flex items-center justify-between">
              <div>
                <CardTitle class="text-sm">Google OAuth2</CardTitle>
                <CardDescription>
                  Allow users to sign in with their Google account.
                </CardDescription>
              </div>
              <Badge :variant="googleEnabled ? 'default' : 'secondary'">
                {{ googleEnabled ? "Enabled" : "Disabled" }}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <form class="space-y-4" @submit.prevent="saveGoogle">
              <div class="flex items-center gap-2">
                <Checkbox id="settings-google-enabled" v-model="googleEnabled" />
                <Label for="settings-google-enabled" class="font-normal">
                  Enable Google OAuth2 globally
                </Label>
              </div>

              <div v-if="googleEnabled" class="space-y-4">
                <div class="space-y-1.5">
                  <Label for="settings-google-client-id">Client ID</Label>
                  <Input
                    id="settings-google-client-id"
                    v-model="googleClientId"
                    placeholder="Google OAuth client ID"
                  />
                </div>
                <div class="space-y-1.5">
                  <Label for="settings-google-client-secret">Client Secret</Label>
                  <Input
                    id="settings-google-client-secret"
                    v-model="googleClientSecret"
                    type="password"
                    placeholder="Google OAuth client secret"
                  />
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-3">
                <Button type="submit" :disabled="savingGoogle || !googleDirty">
                  <Loader2 v-if="savingGoogle" class="h-4 w-4 animate-spin" />
                  Save
                </Button>
                <span class="text-xs text-muted-foreground">
                  Callback URL:
                  <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {{ googleRedirectUrl }}
                  </code>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-7 w-7"
                  title="Copy callback URL"
                  @click="copyRedirectUrl"
                >
                  <Copy class="h-3.5 w-3.5" />
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <!-- ── RATE LIMITER ── -->
      <div v-else-if="activeTab === 'rate-limiter'" class="max-w-4xl space-y-5">
        <div class="border-b pb-4">
          <h3 class="text-base font-semibold">Rate Limiter</h3>
          <p class="mt-0.5 text-sm text-muted-foreground">
            Throttle requests per IP for selected paths.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div class="flex items-center justify-between">
              <CardTitle class="text-sm">Rate Limiting Rules</CardTitle>
              <Badge :variant="rateLimitEnabled ? 'default' : 'secondary'">
                {{ rateLimitEnabled ? "Enabled" : "Disabled" }}
              </Badge>
            </div>
            <CardDescription>
              Patterns support
              <code class="rounded bg-muted px-1 text-xs">*</code>
              wildcards (e.g.
              <code class="rounded bg-muted px-1 text-xs">
                /api/collections/*/auth-with-password
              </code>
              ).
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center gap-2">
              <Checkbox id="settings-rl-enabled" v-model="rateLimitEnabled" />
              <Label for="settings-rl-enabled" class="font-normal">
                Enable rate limiting
              </Label>
            </div>

            <datalist id="rl-pattern-suggestions">
              <option
                v-for="suggestion in patternSuggestions"
                :key="suggestion"
                :value="suggestion"
              />
            </datalist>

            <div class="overflow-hidden rounded-lg border">
              <div
                class="grid grid-cols-[minmax(0,1fr)_110px_110px_140px_40px] gap-2 bg-muted/50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                <div>Path pattern</div>
                <div>Max / IP</div>
                <div>Interval (s)</div>
                <div>Targeted users</div>
                <div />
              </div>
              <div
                v-if="rateRules.length === 0"
                class="p-3 text-xs text-muted-foreground"
              >
                No rules configured.
              </div>
              <div
                v-for="(rule, idx) in rateRules"
                :key="idx"
                class="grid grid-cols-[minmax(0,1fr)_110px_110px_140px_40px] items-center gap-2 border-t px-3 py-2"
              >
                <Input
                  v-model="rule.pattern"
                  list="rl-pattern-suggestions"
                  placeholder="/api/*"
                  autocomplete="off"
                  spellcheck="false"
                  class="h-9 font-mono text-xs"
                  data-testid="rl-pattern"
                />
                <Input
                  v-model.number="rule.maxRequests"
                  type="number"
                  min="1"
                  class="h-9"
                />
                <Input
                  v-model.number="rule.intervalSeconds"
                  type="number"
                  min="1"
                  class="h-9"
                />
                <Select v-model="rule.targetedUsers">
                  <SelectTrigger class="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="guest">Guest only</SelectItem>
                    <SelectItem value="auth">Auth only</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-9 w-9"
                  title="Remove rule"
                  @click="removeRateRule(idx)"
                >
                  <X class="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" data-testid="rl-add-rule" @click="addRateRule">
                + Add rule
              </Button>
              <Button size="sm" :disabled="savingRateLimit" data-testid="rl-save" @click="saveRateLimit">
                <Loader2 v-if="savingRateLimit" class="h-4 w-4 animate-spin" />
                Save
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- ── IMPORT / EXPORT ── -->
      <div v-else-if="activeTab === 'import-export'" class="max-w-3xl space-y-5">
        <div class="border-b pb-4">
          <h3 class="text-base font-semibold">Import / Export</h3>
          <p class="mt-0.5 text-sm text-muted-foreground">
            Migrate schema between Grescale instances.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle class="text-sm">Export Schema</CardTitle>
            <CardDescription>
              Download a JSON file with all your collections, schema, and API
              rules.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button as="a" variant="outline" class="w-full" href="/internal/api/admin/export" download data-testid="export-link">
              <Download class="h-4 w-4" />
              Download Schema (JSON)
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="text-sm">Import Schema</CardTitle>
            <CardDescription>
              Upload an exported JSON file to import collections. Tables and
              views are created automatically; existing collections are skipped.
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <input
              ref="importFileInput"
              type="file"
              accept=".json,application/json"
              class="hidden"
              @change="onImportFile"
            />
            <Button class="w-full" :disabled="importing" @click="triggerImportPicker">
              <Loader2 v-if="importing" class="h-4 w-4 animate-spin" />
              <Upload v-else class="h-4 w-4" />
              Choose JSON file &amp; import
            </Button>

            <div
              v-if="importResult"
              class="space-y-2 rounded-md border p-3 font-mono text-xs"
              data-testid="import-result"
            >
              <p v-for="name in importResult.created" :key="`c-${name}`" class="text-foreground">
                ✓ Created: {{ name }}
              </p>
              <p v-for="name in importResult.skipped" :key="`s-${name}`" class="text-muted-foreground">
                – Skipped (already exists): {{ name }}
              </p>
              <p
                v-for="entry in importResult.errors"
                :key="`e-${entry.name}`"
                class="text-destructive"
              >
                ✗ {{ entry.name }}: {{ entry.error }}
              </p>
              <p
                v-if="
                  importResult.created.length === 0 &&
                  importResult.skipped.length === 0 &&
                  importResult.errors.length === 0"
                class="text-muted-foreground"
              >
                Nothing to import.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- ── BACKUPS ── -->
      <div v-else-if="activeTab === 'backups'" class="max-w-4xl space-y-5">
        <div class="border-b pb-4">
          <h3 class="text-base font-semibold">Backups</h3>
          <p class="mt-0.5 text-sm text-muted-foreground">
            Scheduled PostgreSQL dumps via pg_dump.
          </p>
        </div>

        <Card>
          <CardContent class="space-y-4 pt-6">
            <div v-if="loadingBackups" class="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              Loading backups…
            </div>
            <template v-else>
              <div class="flex flex-wrap items-center justify-between gap-4">
                <div class="flex items-center gap-2">
                  <Checkbox
                    id="settings-backup-enabled"
                    v-model="backupEnabled"
                  />
                  <Label for="settings-backup-enabled" class="font-normal">
                    Enable schedule
                  </Label>
                </div>
                <Button size="sm" :disabled="savingBackupSettings" @click="saveBackupSettings">
                  <Loader2 v-if="savingBackupSettings" class="h-4 w-4 animate-spin" />
                  Save Settings
                </Button>
              </div>

              <div v-if="backupEnabled" class="space-y-4">
                <div class="grid grid-cols-1 items-end gap-3 md:grid-cols-2">
                  <div class="space-y-1.5">
                    <Label>Frequency</Label>
                    <Select v-model="backupFrequency">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          v-for="freq in BACKUP_FREQUENCIES"
                          :key="freq"
                          :value="freq"
                        >
                          {{ freq }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="space-y-1.5">
                    <Label for="settings-backup-retain">Keep last N backups</Label>
                    <Input
                      id="settings-backup-retain"
                      v-model.number="backupRetainCount"
                      type="number"
                      min="1"
                      max="100"
                    />
                  </div>
                </div>

                <div class="flex items-center gap-3">
                  <Button variant="outline" size="sm" :disabled="runningBackup" @click="runBackupNow">
                    <Loader2 v-if="runningBackup" class="h-4 w-4 animate-spin" />
                    <Play v-else class="h-4 w-4" />
                    Run Backup Now
                  </Button>
                  <span class="text-xs text-muted-foreground">
                    Last run: {{ formatDate(backupLastRunAt) }}
                  </span>
                </div>

                <div class="overflow-hidden rounded-lg border">
                  <div
                    class="bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    pg_dump Backups
                  </div>
                  <div
                    v-if="backups.length === 0"
                    class="p-4 text-sm text-muted-foreground"
                  >
                    No backups found yet.
                  </div>
                  <Table v-else>
                    <TableHeader>
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead class="w-40" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow v-for="backup in backups" :key="backup.fileName">
                        <TableCell class="font-mono text-xs">
                          {{ backup.fileName }}
                        </TableCell>
                        <TableCell class="text-xs">
                          {{ formatBytes(backup.sizeBytes) }}
                        </TableCell>
                        <TableCell class="text-xs">
                          {{ formatDate(backup.createdAt) }}
                        </TableCell>
                        <TableCell>
                          <div class="flex items-center gap-2">
                            <Button
                              as="a"
                              variant="outline"
                              size="sm"
                              class="h-8 text-xs"
                              :href="`/internal/api/admin/backups/download/${encodeURIComponent(backup.fileName)}`"
                              download
                            >
                              Download
                            </Button>
                            <Button
                              size="sm"
                              class="h-8 text-xs"
                              @click="restoreTarget = backup.fileName"
                            >
                              Restore
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </div>
            </template>
          </CardContent>
        </Card>
      </div>
    </div>

    <AlertDialog
      :open="restoreTarget !== null"
      @update:open="(v: boolean) => { if (!v) restoreTarget = null; }"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore this backup?</AlertDialogTitle>
          <AlertDialogDescription>
            Restoring
            <span class="font-mono">{{ restoreTarget }}</span>
            will overwrite current database objects. This action cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            :disabled="restoring"
            @click="restoreBackup"
          >
            Restore backup
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
