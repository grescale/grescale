import sql from "../db/db.ts";
import { sign } from "hono/jwt";
import { setCookie, deleteCookie } from "hono/cookie";
import { getRequiredJwtSecret } from "../security.ts";
import { timingSafeEqual } from "crypto";

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$xuhqMAfR86mzzUehilH88BI9eQt2cfTFVtFaLNGxHKU$lN3OOwzqQOEumsiPVBkiVsXHiHSrN4Si57ZREAOEbKk";

function constantTimeEquals(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function handleJsonSetup(c: any) {
  try {
    const adminsCount = await sql`SELECT count(id) FROM _users`;
    if (Number(adminsCount[0].count) > 0) {
      return c.json(
        {
          error:
            "Superadmin already exists. Additional superadmins must be created manually or via admin panel.",
        },
        409,
      );
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body." }, 400);
    }

    // Require the bootstrap setup token until the first admin exists. This
    // prevents an attacker from racing to claim a freshly deployed instance.
    const expectedToken = (process.env.SETUP_TOKEN || "").trim();
    const providedToken =
      (typeof body?.setup_token === "string" && body.setup_token) ||
      c.req.header("X-Setup-Token") ||
      "";
    if (!expectedToken || !constantTimeEquals(providedToken, expectedToken)) {
      return c.json({ error: "Invalid or missing setup token." }, 401);
    }

    const email = typeof body?.email === "string" ? body.email : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || password.length < 8) {
      return c.json(
        {
          error:
            "Valid email and a password of at least 8 characters are required.",
        },
        400,
      );
    }

    const hashedPassword = await Bun.password.hash(password);
    const newAdmin =
      await sql`INSERT INTO _users (email, password, owner) VALUES (${email}, ${hashedPassword}, TRUE) RETURNING id, email, owner, created_at`;

    return c.json({ success: true, admin: newAdmin[0] });
  } catch (err: any) {
    console.error("Setup request error:", err);
    return c.json({ error: "An unexpected error occurred." }, 500);
  }
}

export type AdminUser = { id: string; email: string };

export class LoginError extends Error {
  constructor(public code: "invalid_credentials" | "db_not_initialized") {
    super(code);
  }
}

// Verifies email/password against _users. Runs a dummy hash verification when
// the user does not exist so the response time does not reveal which case it was.
export async function verifyAdminCredentials(
  email: string,
  password: string,
): Promise<AdminUser> {
  const users =
    await sql`SELECT id, email, password FROM _users WHERE email = ${email} LIMIT 1`;
  if (users.length === 0) {
    await Bun.password.verify(password, DUMMY_PASSWORD_HASH);
    throw new LoginError("invalid_credentials");
  }

  const isValid = await Bun.password.verify(password, users[0].password);
  if (!isValid) {
    throw new LoginError("invalid_credentials");
  }

  return { id: users[0].id, email: users[0].email };
}

export async function issueAdminSession(c: any, user: AdminUser) {
  const token = await sign(
    {
      id: user.id,
      email: user.email,
      type: "admin",
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    getRequiredJwtSecret(),
  );

  setCookie(c, "admin_session", token, {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "Strict",
    maxAge: 60 * 60 * 24,
  });
}

export function clearAdminSession(c: any) {
  deleteCookie(c, "admin_session", {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "Strict",
  });
}
