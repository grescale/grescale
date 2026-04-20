import sql from "../db/db.ts";
import { sign } from "hono/jwt";
import { setCookie, deleteCookie } from "hono/cookie";
import { getRequiredJwtSecret } from "../security.ts";

export async function handleSetupRequest(c: any) {
  try {
    const adminsCount = await sql`SELECT count(id) FROM _users`;
    if (adminsCount[0].count > 0) {
      return c.html(
        `<div class="bg-red-100 text-red-700 p-2 rounded text-sm text-center">${"Superadmin already exists. Additional superadmins must be created manually or via admin panel."}</div>`,
      );
    }

    const body = await c.req.parseBody();
    const email = body.email;
    const password = body.password;
    if (!email || !password || password.length < 8) {
      return c.html(
        `<div class="bg-red-100 text-red-700 p-2 rounded text-sm text-center">${"Valid email and a password of at least 8 characters are required."}</div>`,
      );
    }

    const hashedPassword = await Bun.password.hash(password);
    const newAdmin =
      await sql`INSERT INTO _users (email, password, owner) VALUES (${email}, ${hashedPassword}, TRUE) RETURNING id, email, owner, created_at`;

    return c.json({ success: true, admin: newAdmin[0] });
  } catch (err: any) {
    console.error("Setup request error:", err);
    return c.html(
      `<div class="bg-red-100 text-red-700 p-2 rounded text-sm text-center">An unexpected error occurred.</div>`,
    );
  }
}

export async function handleLoginRequest(c: any) {
  const body = await c.req.parseBody();
  const email = body.email as string;
  const password = body.password as string;

  try {
    const users =
      await sql`SELECT id, email, password FROM _users WHERE email = ${email} LIMIT 1`;
    if (users.length === 0) {
      return c.html(
        `<div class="text-destructive text-sm mt-2 font-medium">Invalid credentials.</div>`,
      );
    }

    const isValid = await Bun.password.verify(password, users[0].password);
    if (!isValid) {
      return c.html(
        `<div class="text-destructive text-sm mt-2 font-medium">Invalid credentials.</div>`,
      );
    }

    const user = users[0];
    const finalSecret = getRequiredJwtSecret();

    const token = await sign(
      {
        id: user.id,
        email: user.email,
        type: "admin",
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
      },
      finalSecret,
    );

    setCookie(c, "admin_session", token, {
      path: "/",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 60 * 60 * 24,
    });

    c.header("HX-Redirect", "/collections");
    return c.html(
      `<div class="text-green-600 font-bold mt-2">Logged in successfully! Redirecting...</div>`,
    );
  } catch (err: any) {
    if (err.code === "42P01") {
      return c.html(
        `<div class="text-destructive text-sm mt-2 font-medium">Database not initialized. Please run init.</div>`,
      );
    }
    console.error("Login request error:", err);
    return c.html(
      `<div class="text-destructive text-sm mt-2 font-medium">An unexpected error occurred.</div>`,
    );
  }
}

export async function handleLogoutRequest(c: any) {
  deleteCookie(c, "admin_session", {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "Strict",
  });
  return c.redirect("/login");
}
