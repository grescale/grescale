import { Hono } from "hono";
import {
  deleteCustomEndpointFile,
  listCustomEndpointFiles,
  readCustomEndpointFile,
  writeCustomEndpointFile,
  isCustomEndpointsEnabled,
  getRegisteredEndpointPaths,
} from "../services/customScriptsBackend.ts";

export const customEndpoints = new Hono();

function getCustomEndpointsBasePath(c: any) {
  return c.req.path.startsWith("/admin/") ||
    c.req.path.startsWith("/internal/api/custom-endpoints")
    ? "/internal/api/custom-endpoints"
    : "/api/custom-endpoints";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function defaultScriptTemplate() {
  return `// routerAdd and cronAdd are available in every custom endpoint file.
// Use await c.collection("posts") to get a collection with list, get, create, update, delete methods + rule properties.
// Use db.collection("posts") at the top level if you want a reusable handle.
// Use c.transaction(async ({ sql, db }) => ...) for atomic multi-query writes.
// Custom routes bypass collection API rules by default; call c.canAccessCollection(...) when you need rule enforcement.
// Field validations are automatic: type checking, required fields, min/max for numbers, email/URL/regex patterns, etc.
// Use createWithoutValidation() or updateWithoutValidation() to skip validations.
// Error helpers available globally: ForbiddenError, BadRequestError, UnauthorizedError, NotFoundError, ConflictError.

routerAdd("GET", "/api/hello", (c) => {
  return c.json({ message: "Hello from custom endpoints" });
});

// Example 1: Insert without validations (fast path).
// routerAdd("POST", "/api/collections/posts/raw", async (c) => {
//   const body = await c.body();
//   const posts = await c.collection("posts");
//   const created = await posts.createWithoutValidation({
//     title: body.title,
//     content: body.content,
//     status: body.status || "draft",
//   });
//   return c.json({ ok: true, created }, 201);
// });

// Example 2: Insert with automatic field validations.
// Validations are automatically applied based on field definitions:
// - Type checking (number, text, email, url, date, uuid, etc.)
// - Min/max values for numbers
// - Required fields
// - Email and URL format validation
// - Regex patterns for text fields
// - Non-zero constraint for numbers
// routerAdd("POST", "/api/collections/posts/auto-validate", async (c) => {
//   const body = await c.body();
//   const posts = await c.collection("posts");
//   // This will throw a 400 error if:
//   // - A required field is missing
//   // - A number field has min=2 and value is 1
//   // - An email field doesn't match email format
//   // - A text field with regex doesn't match the pattern
//   const created = await posts.create({
//     title: body.title,        // required, type: text
//     rating: body.rating,      // type: number, min: 1, max: 5
//     author_email: body.email, // type: email
//     content: body.content,    // required, type: richtext
//   });
//   return c.json({ ok: true, created }, 201);
// });

// Example 3: Insert with custom validations + automatic field validations.
// routerAdd("POST", "/api/collections/posts/validated", async (c) => {
//   const body = await c.body();
//   const title = typeof body.title === "string" ? body.title.trim() : "";
//   const email = typeof body.author_email === "string" ? body.author_email.trim().toLowerCase() : "";
//   if (!title || title.length < 3) {
//     return c.json({ error: "title must be at least 3 characters" }, 400);
//   }
//   if (!email) {
//     return c.json({ error: "author_email is required" }, 400);
//   }
//
//   // Optional PocketBase-style rule check in custom route:
//   // const posts = await c.collection("posts");
//   // const allowed = c.canAccessCollection(posts, c.requestInfo(), posts.createRule);
//   // if (!allowed) throw new ForbiddenError();
//
//   const created = await c.transaction(async ({ db }) => {
//     const posts = await db.collection("posts");
//     // Field validations are run here automatically
//     const post = await posts.create({
//       title,
//       content: typeof body.content === "string" ? body.content : "",
//       author_email: email,
//       status: "draft",
//     });
//
//     const logs = await db.collection("audit_logs");
//     await logs.create({
//       action: "post_created",
//       entity: "posts",
//       entity_id: post.id,
//     });
//
//     return post;
//   });
//
//   return c.json({ ok: true, created }, 201);
// });

// Example 3: Accept image from multipart/form-data, store on disk, then insert DB record.
// routerAdd("POST", "/api/collections/posts/upload", async (c) => {
//   const form = await c.request.formData();
//   const title = String(form.get("title") || "").trim();
//
//   if (!title) return c.json({ error: "title is required" }, 400);
//
//   const upload = await c.saveImage("image", "uploads/posts", {
//     formData: form,
//     maxBytes: 5 * 1024 * 1024,
//   });
//
//   const posts = await c.collection("posts");
//   const created = await posts.create({
//     title,
//     image_path: upload.publicPath,
//     mime_type: upload.mimeType,
//     image_size: upload.size,
//   });
//
//   return c.json({ ok: true, created }, 201);
// });

// Example cron job
// cronAdd("* * * * *", async ({ sql, db }) => {
//   const posts = await db.collection("posts");
//   await posts.count("status = 'published'");
//   await sql\`SELECT 1\`;
// });
`;
}

async function renderPage(
  basePath: string,
  selectedFileName?: string,
  isNew = false,
) {
  const files = await listCustomEndpointFiles();
  const selectedFile =
    !isNew && selectedFileName
      ? files.find((file) => file.fileName === selectedFileName)
      : files[0] || null;
  const fileName = isNew
    ? "new-endpoint.gs.js"
    : selectedFile?.fileName || "new-endpoint.gs.js";
  const code = selectedFile
    ? await readCustomEndpointFile(selectedFile.fileName)
    : defaultScriptTemplate();

  const enabled = isCustomEndpointsEnabled();

  const disabledBanner = enabled
    ? ""
    : `
    <div class="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
      <svg class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      <div>
        <p class="font-medium text-amber-800">Custom Endpoints are disabled</p>
        <p class="mt-0.5 text-amber-700">Scripts are stored but will not handle requests until you enable them in
          <a hx-get="${basePath.replace('/internal/api/custom-endpoints', '/admin/collections/system-settings').replace('/api/custom-endpoints', '/admin/collections/system-settings')}" hx-target="#main-content" hx-push-url="/settings" class="font-medium underline hover:text-amber-900">System Settings</a>.
        </p>
      </div>
    </div>`;

  return `
    <div class="flex-1 flex flex-col gap-6">
      ${disabledBanner}
      <div class="flex items-center justify-between border-b pb-4">
        <div>
          <h2 class="text-3xl font-bold tracking-tight">Custom Endpoints</h2>
          <p class="text-sm text-muted-foreground">Filesystem-backed scripts in <span class="font-mono">custom_endpoints/</span> reload automatically when saved.</p>
        </div>
        <button
          hx-get="${basePath}?new=1"
          hx-target="#main-content"
          hx-push-url="/custom-endpoints?new=1"
          class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2"
        >
          + New Script
        </button>
      </div>

      <div class="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div class="rounded-xl border bg-card text-card-foreground shadow-sm p-4">
          <div class="mb-3 flex items-center justify-between">
            <h3 class="font-semibold">Scripts</h3>
            <span class="text-xs text-muted-foreground font-mono">${files.length} files</span>
          </div>
          <div class="space-y-2 max-h-[560px] overflow-y-auto pr-1">
            ${
              files.length === 0
                ? '<div class="text-sm text-muted-foreground p-4 border border-dashed rounded">No scripts yet.</div>'
                : files
                    .map(
                      (file) => `
                        <button
                          hx-get="${basePath}?file=${encodeURIComponent(file.fileName)}"
                          hx-target="#main-content"
                          hx-push-url="/custom-endpoints?file=${encodeURIComponent(file.fileName)}"
                          class="w-full text-left rounded-lg border px-3 py-2 transition ${selectedFile?.fileName === file.fileName ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}"
                        >
                          <div class="font-mono text-sm text-foreground">${escapeHtml(file.fileName)}</div>
                          <div class="mt-1 text-xs text-muted-foreground">${file.size} bytes</div>
                        </button>
                      `,
                    )
                    .join("")
            }
          </div>
        </div>

        <div class="rounded-xl border bg-card text-card-foreground shadow-sm p-6">
          <form hx-post="${basePath}/save" hx-target="#main-content" class="space-y-4">
            <input type="hidden" name="original_name" value="${escapeHtml(selectedFile?.fileName || "")}" />
            <div class="grid gap-4 md:grid-cols-2">
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">File Name</label>
                <input type="text" name="file_name" value="${escapeHtml(fileName)}" placeholder="posts.gs.js" class="w-full flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
              </div>
              <div>
                <label class="block text-sm font-medium text-foreground mb-1">Reload</label>
                <div class="h-10 flex items-center rounded-md border border-input bg-muted/30 px-3 text-sm text-muted-foreground">Changes are picked up automatically.</div>
              </div>
            </div>

            <div>
              <label class="block text-sm font-medium text-foreground mb-1">Script</label>
              <textarea name="code" rows="26" class="w-full rounded-md border border-input bg-background px-3 py-3 text-sm font-mono leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">${escapeHtml(code)}</textarea>
            </div>

            <div class="flex items-center justify-between gap-3 pt-2">
              <div class="text-xs text-muted-foreground">
                Use <span class="font-mono">routerAdd("METHOD", "/api/path/:id", (c) => ...)</span>, <span class="font-mono">c.canAccess(collectionOrRecord, auth, rule, context?)</span>, <span class="font-mono">c.transaction(async ({ sql, db }) => ...)</span>, <span class="font-mono">c.collection("posts")</span>, <span class="font-mono">c.db.collection("posts")</span>, and <span class="font-mono">cronAdd("* * * * *", async ({ sql, db }) => ...)</span>.
              </div>
              <div class="flex gap-2">
                ${
                  selectedFile
                    ? `
                    <button type="button" hx-post="${basePath}/delete" hx-include="closest form" hx-target="#main-content" hx-confirm="Delete this script?" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 h-10 px-4 py-2">Delete</button>
                  `
                    : ""
                }
                <button type="submit" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2">Save Script</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
}

/** Returns the live set of registered custom endpoint paths as JSON.
 * Used by the admin rate-limiter autocomplete to add dynamic suggestions. */
customEndpoints.get("/routes", (c) => {
  return c.json(getRegisteredEndpointPaths());
});

customEndpoints.get("/", async (c) => {
  const basePath = getCustomEndpointsBasePath(c);
  const selectedFile = c.req.query("file") || undefined;
  const isNew = c.req.query("new") === "1";
  return c.html(await renderPage(basePath, selectedFile, isNew));
});

customEndpoints.post("/save", async (c) => {
  const basePath = getCustomEndpointsBasePath(c);
  const body = await c.req.parseBody();
  const originalName =
    typeof body.original_name === "string" ? body.original_name.trim() : "";
  const fileName =
    typeof body.file_name === "string" ? body.file_name.trim() : "";
  const code = typeof body.code === "string" ? body.code : "";

  if (!fileName) {
    return c.json({ error: "File name is required." }, 422);
  }

  const normalizedName = await writeCustomEndpointFile(fileName, code);
  if (originalName && originalName !== normalizedName) {
    await deleteCustomEndpointFile(originalName);
  }

  return c.html(`
    <script>
      showToast("Custom endpoint saved successfully.", "success");
      history.pushState({}, '', '/custom-endpoints?file=${encodeURIComponent(normalizedName)}');
    </script>
    ${await renderPage(basePath, normalizedName, false)}
  `);
});

customEndpoints.post("/delete", async (c) => {
  const basePath = getCustomEndpointsBasePath(c);
  const body = await c.req.parseBody();
  const fileName =
    typeof body.original_name === "string" ? body.original_name.trim() : "";

  if (!fileName) {
    return c.json({ error: "Missing file name." }, 422);
  }

  await deleteCustomEndpointFile(fileName);

  return c.html(`
    <script>
      showToast("Custom endpoint deleted successfully.", "success");
      history.pushState({}, '', '/custom-endpoints');
    </script>
    ${await renderPage(basePath, undefined, true)}
  `);
});

export default customEndpoints;
