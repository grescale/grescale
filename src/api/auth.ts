import { Hono } from "hono";
import {
  handleLoginRequest,
  handleLogoutRequest,
  handleSetupRequest,
} from "../services/authBackend.ts";

const auth = new Hono();

auth.use("*", async (c, next) => {
  const isHtmxRequest =
    c.req.header("HX-Request") === "true" ||
    c.req.header("hx-request") === "true";

  if (!isHtmxRequest) {
    return c.notFound();
  }

  await next();
});

auth.post("/setup", handleSetupRequest);

auth.post("/login", handleLoginRequest);

auth.post("/logout", handleLogoutRequest);

export default auth;
