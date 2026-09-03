import { Hono } from "hono";
import { handleJsonSetup } from "../services/authBackend.ts";
import {
  handleJsonLogin,
  handleJsonLogout,
  handleJsonMe,
} from "./authJson.ts";
import { hasSameOriginHeader } from "../middleware/auth.ts";

const auth = new Hono();

// CSRF gate: all auth endpoints require the SPA's same-origin request header.
auth.use("*", async (c, next) => {
  if (!hasSameOriginHeader(c)) {
    return c.notFound();
  }

  await next();
});

auth.post("/setup", handleJsonSetup);

auth.post("/login", handleJsonLogin);

auth.post("/logout", handleJsonLogout);

auth.get("/me", handleJsonMe);

export default auth;
