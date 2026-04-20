import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import { getRequiredJwtSecret } from "../security.ts";

export const requireAdminAuth = async (c: any, next: any) => {
  // Admin panel only: requires HTMX request + valid cookie
  const isHtmxRequest =
    c.req.header("HX-Request") === "true" ||
    c.req.header("hx-request") === "true";

  if (!isHtmxRequest) {
    return c.notFound();
  }

  // Admin panel only: use cookies
  const token = getCookie(c, "admin_session") || null;

  if (!token) {
    return c.html(
      `<span class="text-red-500">Unauthorized: Please log in first.</span>`,
      401,
    );
  }

  try {
    const payload = await verify(token, getRequiredJwtSecret(), "HS256");

    // Throw forbidden if not superadmin
    if (payload.type !== "admin") {
      return c.html(
        `<span class="text-red-500">Forbidden: Superadmin access required.</span>`,
        403,
      );
    }

    // Store user data in context for downstream routes
    c.set("user", payload);
    await next();
  } catch (err) {
    return c.html(
      `<span class="text-red-500">Unauthorized: Invalid or expired session.</span>`,
      401,
    );
  }
};
