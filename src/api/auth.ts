import { Hono } from "hono";
import {
  handleLoginRequest,
  handleLogoutRequest,
  handleSetupRequest,
} from "../services/authBackend.ts";

const auth = new Hono();

auth.post("/setup", handleSetupRequest);

auth.post("/login", handleLoginRequest);

auth.post("/logout", handleLogoutRequest);

export default auth;
