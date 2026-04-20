import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import { getRequiredJwtSecret } from "../security.ts";

export const requireAuth = async (c: any, next: any) => {
  const isApiRequest = c.req.path.startsWith("/api/");
  const isInternalApiRequest = c.req.path.startsWith("/internal/api/");
  const isAdminRequest = c.req.path.startsWith("/admin/");
  let token: string | null = null;

  if (isApiRequest) {
    // /api routes: require Authorization header (for external clients)
    const authHeader = c.req.header("Authorization");
    token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return c.json(
        {
          code: 401,
          message:
            "The request requires valid admin authorization token to be set.",
          data: {},
        },
        401,
      );
    }
  } else if (isInternalApiRequest) {
    const isHtmxRequest =
      c.req.header("HX-Request") === "true" ||
      c.req.header("hx-request") === "true";

    if (!isHtmxRequest) {
      return c.notFound();
    }

    // Internal admin routes: use the admin session cookie, but only when the request
    // originates from the admin UI (HTMX adds the request header automatically).
    token = getCookie(c, "admin_session") || null;

    if (!token) {
      return c.html(
        `<span class="text-red-500">Unauthorized: Please log in first.</span>`,
        401,
      );
    }
  } else if (isAdminRequest) {
    // /admin routes: require HTMX request + cookie (for admin UI only)
    const isHtmxRequest =
      c.req.header("HX-Request") === "true" ||
      c.req.header("hx-request") === "true";

    if (!isHtmxRequest) {
      return c.notFound();
    }

    token = getCookie(c, "admin_session") || null;

    if (!token) {
      return c.html(
        `<span class="text-red-500">Unauthorized: Please log in first.</span>`,
        401,
      );
    }
  } else {
    // Other routes shouldn't use this middleware
    await next();
    return;
  }

  try {
    const payload = await verify(token, getRequiredJwtSecret(), "HS256");

    // Throw forbidden if not superadmin
    if (payload.type !== "admin") {
      if (isApiRequest) {
        return c.json(
          {
            code: 403,
            message:
              "The request requires valid admin authorization token to be set.",
            data: {},
          },
          403,
        );
      }
      return c.html(
        `<span class="text-red-500">Forbidden: Superadmin access required.</span>`,
        403,
      );
    }

    // Store user data in context for downstream routes
    c.set("user", payload);
    await next();
  } catch (err) {
    if (isApiRequest) {
      return c.json(
        {
          code: 401,
          message:
            "The request requires valid admin authorization token to be set.",
          data: {},
        },
        401,
      );
    }
    return c.html(
      `<span class="text-red-500">Unauthorized: Invalid or expired session.</span>`,
      401,
    );
  }
};
