import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import { getRequiredJwtSecret } from "../security.ts";
import sql from "../db/db.ts";
import {
  clearAdminSession,
  issueAdminSession,
  LoginError,
  verifyAdminCredentials,
} from "../services/authBackend.ts";

export async function handleJsonLogin(c: any) {
  let email = "";
  let password = "";
  try {
    const body = await c.req.json();
    email = typeof body?.email === "string" ? body.email : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  if (!email || !password) {
    return c.json({ error: "Email and password are required." }, 400);
  }

  try {
    const user = await verifyAdminCredentials(email, password);
    await issueAdminSession(c, user);
    return c.json({ id: user.id, email: user.email, type: "admin" });
  } catch (err: any) {
    if (err instanceof LoginError && err.code === "invalid_credentials") {
      return c.json({ error: "Invalid credentials." }, 401);
    }
    if (err.code === "42P01") {
      return c.json({ error: "Database not initialized." }, 503);
    }
    console.error("JSON login error:", err);
    return c.json({ error: "An unexpected error occurred." }, 500);
  }
}

export async function handleJsonLogout(c: any) {
  clearAdminSession(c);
  return c.json({ ok: true });
}

export async function handleJsonMe(c: any) {
  const token = getCookie(c, "admin_session");
  if (!token) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  try {
    const payload = await verify(token, getRequiredJwtSecret(), "HS256");
    if (payload.type !== "admin" || !payload.id) {
      return c.json({ error: "Unauthorized." }, 401);
    }

    // Re-verify the admin still exists so revoked accounts can't reuse a token.
    const rows =
      await sql`SELECT id, email FROM _users WHERE id = ${payload.id} LIMIT 1`;
    if (rows.length === 0) {
      return c.json({ error: "Unauthorized." }, 401);
    }

    return c.json({ id: rows[0].id, email: rows[0].email, type: "admin" });
  } catch {
    return c.json({ error: "Unauthorized." }, 401);
  }
}
