import { initDb } from "./db/db.ts";
import { initializeDatabase } from "./db/init.ts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import {
  loadCustomScripts,
  customRouter,
  initCustomEndpointsEnabledFromDb,
} from "./services/customScriptsBackend.ts";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";

import { verify } from "hono/jwt";
import { getCookie } from "hono/cookie";
import { getRequiredJwtSecret } from "./security.ts";
import { timingSafeEqual } from "crypto";
const { upgradeWebSocket, websocket } = createBunWebSocket();

import sql from "./db/db.ts";
import authRoutes from "./api/auth.ts";
import adminApiRoutes from "./api/adminApi.ts";
import adminDownloadsRoutes from "./api/adminDownloads.ts";
import publicApiRoutes from "./api/public.ts";
import { requireAuth } from "./middleware/auth.ts";
import { globalRateLimit } from "./middleware/rateLimit.ts";

const app = new Hono();

let dbBootstrapDone = false;
let dbBootstrapPromise: Promise<void> | null = null;

async function ensureDatabaseBootstrapped() {
  if (dbBootstrapDone) return;

  if (!dbBootstrapPromise) {
    dbBootstrapPromise = initializeDatabase()
      .then(() => {
        dbBootstrapDone = true;
      })
      .catch((err) => {
        // Do not crash startup paths; request flow will surface connection issues.
        console.warn("Database bootstrap warning:", err);
        dbBootstrapPromise = null;
      });
  }

  await dbBootstrapPromise;
}

// One-time bootstrap token required until both DATABASE_URL is configured
// and the first admin exists. Set via env; auto-generated if absent. The token
// is only printed to the server log while bootstrap is incomplete (no admin
// yet) to avoid leaving secrets in logs once the instance is claimed.
const BOOTSTRAP_TOKEN_FROM_ENV = (() => {
  const existing = process.env.SETUP_TOKEN;
  return existing && existing.trim() ? existing.trim() : "";
})();
const BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN_FROM_ENV || randomUUID();
if (!BOOTSTRAP_TOKEN_FROM_ENV) {
  process.env.SETUP_TOKEN = BOOTSTRAP_TOKEN;
}

let bootstrapTokenPrinted = false;
async function maybePrintBootstrapToken() {
  if (bootstrapTokenPrinted) return;
  if (BOOTSTRAP_TOKEN_FROM_ENV) {
    bootstrapTokenPrinted = true;
    return;
  }
  let adminExists = false;
  try {
    if (process.env.DATABASE_URL) {
      const res = await sql`SELECT 1 FROM _users LIMIT 1`;
      adminExists = res.length > 0;
    }
  } catch {
    adminExists = false;
  }
  if (adminExists) {
    bootstrapTokenPrinted = true;
    return;
  }
  console.log(
    "\n============================================================\n" +
      "SETUP_TOKEN (required to complete bootstrap):\n" +
      `  ${BOOTSTRAP_TOKEN}\n` +
      "Share this with the operator completing initial setup.\n" +
      "============================================================\n",
  );
  bootstrapTokenPrinted = true;
}
void maybePrintBootstrapToken();

function constantTimeEquals(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function verifyBootstrapToken(c: any, provided: unknown) {
  const expected = BOOTSTRAP_TOKEN;
  const suppliedHeader = c.req.header("X-Setup-Token") || "";
  const supplied =
    typeof provided === "string" && provided.length > 0
      ? provided
      : suppliedHeader;
  if (!supplied) return false;
  return constantTimeEquals(supplied, expected);
}

function upsertEnvVar(content: string, key: string, value: string) {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = `${key}="${escaped}"`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return `${content.trim()}\n${line}\n`.replace(/^\n/, "");
}

// Configurable per-path rate limiting (driven by _settings.rate_limiting).
app.use("*", globalRateLimit);

// Baseline production-safe response headers.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()", {
    append: false,
  });
  if (process.env.NODE_ENV === "production") {
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }
});

// Database Connection & Onboarding Middleware
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;

  // Serve static assets regardless
  if (path.startsWith("/assets/") || /\.[a-zA-Z0-9]{1,10}$/.test(path)) {
    return next();
  }

  // Phase 1: Needs Database Details
  if (!process.env.DATABASE_URL) {
    if (path === "/setup-db") return next();
    return c.redirect("/setup-db");
  }

  if (path === "/setup-db") {
    return c.redirect("/");
  }

  // Ensure idempotent startup migrations/repairs run on normal healthy boot too.
  await ensureDatabaseBootstrapped();

  // Phase 2: Verify Database Connection & Check Admins
  let adminCount = 0;
  try {
    const res = await sql`SELECT count(id) FROM _users`;
    adminCount = parseInt(res[0].count);
  } catch (err: any) {
    // If it fails to connect entirely because of bad credentials:
    if (
      err.message?.includes("authentication failed") ||
      err.message?.includes("connect")
    ) {
      console.error("Database startup error:", err);
      return c.html(
        `<div style="font-family: sans-serif; padding: 20px; color: red;"><h1>Database Error</h1><p>Unable to connect to the database.</p><p>Update your environment configuration or restart the server.</p></div>`,
      );
    } else {
      // Means tables might not exist, initialize them dynamically
      try {
        await initializeDatabase();
      } catch (e) {}
    }
  }

  if (adminCount === 0) {
    if (path === "/setup" || path === "/internal/api/auth/setup") return next();
    return c.redirect("/setup");
  }

  if (path === "/setup") {
    return c.redirect("/");
  }

  // Phase 3: Everything ready, redirect root to /login
  if (path === "/") {
    return c.redirect("/login");
  }

  return next();
});

app.post("/setup-db", async (c) => {
  const body = await c.req.parseBody();
  const dbUrl =
    typeof body["database_url"] === "string" ? body["database_url"].trim() : "";
  const providedToken =
    typeof body["setup_token"] === "string" ? body["setup_token"] : "";

  if (!verifyBootstrapToken(c, providedToken)) {
    return c.redirect("/setup-db?error=Invalid%20setup%20token");
  }

  if (!dbUrl) return c.redirect("/setup-db?error=URL is required");

  try {
    initDb(dbUrl); // Sets proxy and tests
    await sql`SELECT 1`; // Ping

    // Save to .env
    let envContent = "";
    if (existsSync(".env")) envContent = readFileSync(".env", "utf-8");

    envContent = upsertEnvVar(envContent, "DATABASE_URL", dbUrl);

    // Generate JWT Secret if absent
    if (!process.env.JWT_SECRET) {
      const secret = randomUUID() + randomUUID();
      process.env.JWT_SECRET = secret;
      envContent = upsertEnvVar(envContent, "JWT_SECRET", secret);
    }

    writeFileSync(".env", envContent.trim() + "\n");

    // Attempt Table Initialization natively
    try {
      await initializeDatabase();
    } catch (e) {
      console.log(
        "Initialization might have completed already or had an issue:",
        e,
      );
    }

    return c.redirect("/setup");
  } catch (err: any) {
    process.env.DATABASE_URL = ""; // Unset to force prompt again
    console.error("Database setup error:", err);
    return c.redirect("/setup-db?error=Setup%20failed");
  }
});

// Global Logger Middleware
app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const url = c.req.url;
  const path = new URL(url).pathname;

  // Extract collection name if it's an API route
  let collection = null;
  const collectionMatch = path.match(/^\/api\/collections\/([^\/]+)/);
  if (
    collectionMatch &&
    collectionMatch[1] &&
    !["new", "settings", "new-record", "logs"].includes(collectionMatch[1])
  ) {
    collection = collectionMatch[1];
  }

  try {
    await next();

    // Log success or expected errors
    const status = c.res.status;
    const userIp = c.req.header("x-forwarded-for") || "unknown";
    const userAgent = c.req.header("user-agent") || "unknown";

    // Fire and forget log insertion
    sql`
      INSERT INTO _logs (method, url, status, collection, user_ip, user_agent)
      VALUES (${method}, ${path}, ${status}, ${collection}, ${userIp}, ${userAgent})
    `
      .then(() => {
        const payload = JSON.stringify({
          method,
          path,
          status,
          collection,
          created_at: new Date().toISOString(),
        });
        for (let ws of logClients) {
          ws.send(payload);
        }
      })
      .catch((err) => console.error("Logging error:", err));
  } catch (err: any) {
    // Log unexpected errors
    const status = err.status || 500;
    const userIp = c.req.header("x-forwarded-for") || "unknown";
    const userAgent = c.req.header("user-agent") || "unknown";
    const errorMsg = err.message || String(err);

    sql`
      INSERT INTO _logs (method, url, status, error, collection, user_ip, user_agent)
      VALUES (${method}, ${path}, ${status}, ${errorMsg}, ${collection}, ${userIp}, ${userAgent})
    `
      .then(() => {
        const payload = JSON.stringify({
          method,
          path,
          status,
          collection,
          error: errorMsg,
          created_at: new Date().toISOString(),
        });
        for (let ws of logClients) {
          ws.send(payload);
        }
      })
      .catch((e) => console.error("Logging error:", e));

    throw err;
  }
});

// Always mount the custom endpoint dispatcher; it checks the runtime enabled flag
// on each request so it can be toggled live from the admin UI without a restart.
app.route("/", customRouter);

// Initialize the enabled flag from _settings (falls back to ENABLE_CUSTOM_ENDPOINTS env var).
// Then load any existing scripts if enabled.
if (process.env.DATABASE_URL) {
  try {
    await initCustomEndpointsEnabledFromDb();
    await loadCustomScripts();
  } catch (e) {}
} else {
  // DB URL not known yet; the flag will be initialized after DB setup completes.
  const raw = (process.env.ENABLE_CUSTOM_ENDPOINTS || "").trim().toLowerCase();
  const envEnabled =
    raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  if (envEnabled) {
    // Will be loaded when DB is ready.
    console.log(
      "[custom-endpoints] ENABLE_CUSTOM_ENDPOINTS is set; scripts will load after DB setup.",
    );
  }
}

// Mount modules
app.route("/internal/api/auth", authRoutes);

// Cookie-only download routes for the admin SPA (backup + schema export).
// Mounted BEFORE the gated admin API so plain browser navigations reach them;
// the sub-app carries its own cookie auth and only registers these two paths.
app.route("/internal/api/admin", adminDownloadsRoutes);

// JSON admin API for the Vue SPA (same cookie + same-origin header gate).
const adminApiWrapper = new Hono();
adminApiWrapper.use("*", requireAuth);
adminApiWrapper.route("/", adminApiRoutes);
app.route("/internal/api/admin", adminApiWrapper);

app.route("/api", publicApiRoutes);

// WebSocket for Realtime Logs
let logClients = new Set<any>();

app.get(
  "/api/logs/stream",
  async (c, next) => {
    if (!(await ensureAdminSession(c))) {
      return c.text("Unauthorized", 401);
    }
    return next();
  },
  upgradeWebSocket((c) => {
    return {
      onOpen(event, ws) {
        logClients.add(ws);
      },
      onClose(event, ws) {
        logClients.delete(ws);
      },
    };
  }),
);

async function ensureAdminSession(c: any) {
  try {
    const token = getCookie(c, "admin_session");
    if (!token) return false;
    const payload = await verify(token, getRequiredJwtSecret(), "HS256");
    if (payload.type !== "admin") return false;
    return true;
  } catch {
    return false;
  }
}

app.get("/health", (c) => {
  return c.json({ status: "OK" });
});

// --- Admin SPA serving (Vue app built into web/dist) -----------------------

const SPA_DIST = "./web/dist";
const SPA_INDEX = `${SPA_DIST}/index.html`;

// Hashed build assets and any files copied from web/public (favicon, icons).
// Misses fall through to the SPA fallback below.
app.use("/*", serveStatic({ root: SPA_DIST }));

// SPA fallback: any GET that is not an API endpoint serves the app's
// index.html so client-side routes survive deep links and reloads.
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (
    path.startsWith("/internal/") ||
    path.startsWith("/api/") ||
    path === "/admin" ||
    path.startsWith("/admin/")
  ) {
    return c.notFound();
  }
  if (!existsSync(SPA_INDEX)) {
    return c.text(
      "Admin SPA not built yet. Run `npm --prefix web run build`, or use `npm --prefix web run dev` during development.",
      503,
    );
  }
  return c.html(await Bun.file(SPA_INDEX).text());
});

export default {
  port: process.env.PORT || 8080,
  fetch: app.fetch,
  websocket,
};

console.log(`Server running at http://localhost:${process.env.PORT || 8080}`);
