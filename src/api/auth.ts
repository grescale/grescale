import { Hono } from "hono";
import { sign } from "hono/jwt";
import { setCookie, deleteCookie } from "hono/cookie";
import sql from "../db/db.ts";

const auth = new Hono();

auth.post("/setup", async (c) => {
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
      await sql`INSERT INTO _users (email, password) VALUES (${email}, ${hashedPassword}) RETURNING id, email, created_at`;
    return c.json({ success: true, admin: newAdmin[0] });
  } catch (err: any) {
    return c.html(
      `<div class="bg-red-100 text-red-700 p-2 rounded text-sm text-center">${process.env.NODE_ENV === "production" ? "Internal server error" : err.message}</div>`,
    );
  }
});

auth.post("/login", async (c) => {
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
    const secret = process.env.JWT_SECRET;
    if (!secret && process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET must be set in production");
    }
    const finalSecret = secret || "super-secret-default-key";

    // Create JWT containing the user ID and Email
    const token = await sign(
      {
        id: user.id,
        email: user.email,
        type: "admin",
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
      },
      finalSecret,
    );

    // Set a secure HttpOnly cookie for HTMX to automatically send back
    setCookie(c, "admin_session", token, {
      path: "/",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 60 * 60 * 24,
    });

    c.header("HX-Redirect", "/admin");
    return c.html(
      `<div class="text-green-600 font-bold mt-2">Logged in successfully! Redirecting...</div>`,
    );
  } catch (err: any) {
    if (err.code === "42P01") {
      return c.html(
        `<div class="text-destructive text-sm mt-2 font-medium">Database not initialized. Please run init.</div>`,
      );
    }
    return c.html(
      `<div class="text-destructive text-sm mt-2 font-medium">Error: ${process.env.NODE_ENV === "production" ? "Internal server error" : err.message}</div>`,
    );
  }
});

auth.post("/logout", async (c) => {
  deleteCookie(c, "admin_session", {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "Strict",
  });
  return c.redirect("/login");
});

export default auth;
