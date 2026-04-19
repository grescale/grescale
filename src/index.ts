import { initDb } from "./db/db.ts";
import { initializeDatabase } from "./db/init.ts";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { loadCustomScripts, customRouter } from "./customScripts.ts";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";

import { verify } from "hono/jwt";
import { getCookie } from "hono/cookie";
const { upgradeWebSocket, websocket } = createBunWebSocket();

import sql from "./db/db.ts";
import authRoutes from "./api/auth.ts";
import customEndpointsRoutes from "./api/customEndpoints.ts";
import collectionRoutes from "./api/collections.ts";
import publicApiRoutes from "./api/public.ts";
import adminRoutes from "./api/adminRoutes.ts";
import { requireAuth } from "./middleware/auth.ts";

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

function upsertEnvVar(content: string, key: string, value: string) {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = `${key}="${escaped}"`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return `${content.trim()}\n${line}\n`.replace(/^\n/, "");
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  }
  return secret || "super-secret-default-key";
}

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
  if (
    path.startsWith("/assets/") ||
    path.endsWith(".css") ||
    path.endsWith(".js") ||
    path.endsWith(".html")
  ) {
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
      return c.html(
        `<div style="font-family: sans-serif; padding: 20px; color: red;"><h1>Database Error</h1><p>${err.message}</p><p>Update your .env file or restart the server.</p></div>`,
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

app.get("/setup-db", (c) => {
  const error = c.req.query("error");
  const errMsg = error
    ? `<div class="bg-red-100 text-red-700 p-3 rounded mb-4">${error}</div>`
    : "";
  return c.html(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Grescale - Database Setup</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-50 h-screen flex flex-col items-center justify-center font-sans text-slate-800">
      <div class="w-full max-w-md bg-white rounded-xl shadow p-8">
        <h1 class="text-2xl font-bold mb-2">Connect to Postgres</h1>
        <p class="text-sm text-slate-500 mb-6">You need a PostgreSQL database to run Grescale.</p>
        ${errMsg}
        <form method="POST" action="/setup-db" class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Database URL</label>
            <input type="text" name="database_url" placeholder="postgres://user:pass@localhost:5432/grescale" required class="w-full border p-2 rounded w-full">
          </div>
          <button type="submit" class="w-full bg-slate-900 text-white font-bold p-2 rounded hover:bg-slate-800">Connect & Initialize</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post("/setup-db", async (c) => {
  const body = await c.req.parseBody();
  const dbUrl =
    typeof body["database_url"] === "string" ? body["database_url"].trim() : "";

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
    return c.redirect("/setup-db?error=" + encodeURIComponent(err.message));
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

// Mount custom endpoint dispatcher before API routes so it can intercept custom paths.
app.route("/", customRouter);

// Load dynamic filesystem-backed custom endpoint scripts.
if (process.env.DATABASE_URL) {
  try {
    await loadCustomScripts();
  } catch (e) {}
}

// Mount modules
app.route("/internal/api/auth", authRoutes);

// Protect internal API routes with auth (requires Authorization header for /internal/api/)
const apiCollectionsWrapper = new Hono();
apiCollectionsWrapper.use("*", requireAuth);
apiCollectionsWrapper.route("/", collectionRoutes);
app.route("/internal/api/collections", apiCollectionsWrapper);

const apiCustomEndpointsWrapper = new Hono();
apiCustomEndpointsWrapper.use("*", requireAuth);
apiCustomEndpointsWrapper.route("/", customEndpointsRoutes);
app.route("/internal/api/custom-endpoints", apiCustomEndpointsWrapper);

app.route("/api", publicApiRoutes);
app.route("/admin", adminRoutes);

// WebSocket for Realtime Logs
let logClients = new Set<any>();

app.get(
  "/api/logs/stream",
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

// Serve static files from the public directory
app.use("/*", serveStatic({ root: "./public" }));

// API route to get current time from DB
app.get("/api/time", async (c) => {
  try {
    const result = await sql`SELECT NOW()`;
    return c.html(
      `<span class="text-green-600 font-bold">${result[0].now.toISOString()}</span>`,
    );
  } catch (error) {
    console.error(error);
    return c.html(
      `<span class="text-red-500">Database connection failed</span>`,
    );
  }
});

// Example route returning HTML for HTMX

async function ensureAdminSession(c: any) {
  try {
    const token = getCookie(c, "admin_session");
    if (!token) return false;
    const payload = await verify(token, getJwtSecret(), "HS256");
    if (payload.type !== "admin") return false;
    return true;
  } catch {
    return false;
  }
}

async function renderAdminShell(c: any) {
  const isAdmin = await ensureAdminSession(c);
  if (!isAdmin) return c.redirect("/login");
  const html = await Bun.file("src/views/admin.html").text();
  return c.html(html);
}

// Protected Admin Panel
app.get("/admin", async (c) => {
  return c.redirect("/collections");
});

app.get("/dashboard", async (c) => {
  return await renderAdminShell(c);
});

// Deep-link routes for admin shell pages pushed by HTMX.
app.get("/collections", async (c) => {
  return await renderAdminShell(c);
});

app.get("/collections/:collection", async (c) => {
  return await renderAdminShell(c);
});

app.get("/settings", async (c) => {
  return await renderAdminShell(c);
});

app.get("/logs", async (c) => {
  return await renderAdminShell(c);
});

app.get("/api-tester", async (c) => {
  return await renderAdminShell(c);
});

app.get("/sql-explorer", async (c) => {
  return await renderAdminShell(c);
});

app.get("/custom-endpoints", async (c) => {
  return await renderAdminShell(c);
});

// Login Page
app.get("/setup", async (c) => {
  const html = await Bun.file("public/setup.html").text();
  return c.html(html);
});

app.get("/login", async (c) => {
  try {
    const token = getCookie(c, "admin_session");
    if (token) {
      const payload = await verify(token, getJwtSecret(), "HS256");
      if (payload.type === "admin") return c.redirect("/collections");
    }
  } catch {
    // Invalid token, keep login page flow.
  }
  const html = await Bun.file("public/login.html").text();
  return c.html(html);
});

// Redirect root
app.get("/", (c) => {
  return c.redirect("/login");
});

app.get("/health", (c) => {
  return c.json({ status: "OK" });
});

export default {
  port: process.env.PORT || 8080,
  fetch: app.fetch,
  websocket,
};

console.log(`Server running at http://localhost:${process.env.PORT || 8080}`);
