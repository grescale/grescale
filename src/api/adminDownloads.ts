import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import { access } from "fs/promises";
import { join } from "path";
import sql from "../db/db.ts";
import { getRequiredJwtSecret } from "../security.ts";
import {
  PG_BACKUP_DIR,
  sanitizeBackupFilename,
} from "../services/collectionsBackend.ts";

// File downloads for the admin SPA. These must work from a plain browser
// navigation (<a href>), so they require the admin_session cookie only and
// skip the X-Requested-With same-origin header gate used by the
// rest of /internal/api. A GET file download cannot be read cross-origin,
// only saved, so cookie auth is sufficient here.
const adminDownloads = new Hono();

const requireAdminCookie = async (c: any, next: any) => {
  const token = getCookie(c, "admin_session");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const payload = await verify(token, getRequiredJwtSecret(), "HS256");
    if (payload.type !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Re-verify the admin still exists so revoked accounts can't reuse a token.
    const userId = (payload as any).id;
    if (!userId) {
      throw new Error("Token missing user id");
    }
    const rows =
      await sql`SELECT id FROM _users WHERE id = ${userId} LIMIT 1`;
    if (rows.length === 0) {
      throw new Error("User no longer exists");
    }

    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
};

adminDownloads.use("/backups/download/*", requireAdminCookie);
adminDownloads.use("/export", requireAdminCookie);

adminDownloads.get("/backups/download/:filename", async (c) => {
  try {
    const safeName = sanitizeBackupFilename(c.req.param("filename"));
    const fullPath = join(PG_BACKUP_DIR, safeName);
    await access(fullPath);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${safeName}"`);
    return c.body(await Bun.file(fullPath).arrayBuffer());
  } catch {
    return c.json({ error: "Backup file not found" }, 404);
  }
});

adminDownloads.get("/export", async (c) => {
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
    console.error("Export error:", err);
    return c.json({ error: "Failed to export" }, 500);
  }
});

export default adminDownloads;
