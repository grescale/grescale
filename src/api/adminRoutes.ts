import { Hono } from "hono";
import { requireAdminAuth } from "../middleware/adminAuth.ts";
import collectionRoutes from "./collections.ts";
import customEndpointsRoutes from "./customEndpoints.ts";

// Admin-only routes (for HTMX requests from the admin panel)
// These use the requireAdminAuth middleware which requires cookies only
const adminRoutes = new Hono();

adminRoutes.use("*", requireAdminAuth);

// Mount the routes directly (they no longer have their own auth middleware)
adminRoutes.route("/collections", collectionRoutes);
adminRoutes.route("/custom-endpoints", customEndpointsRoutes);

// Dashboard shortcut (redirects to collections)
adminRoutes.get("/dashboard", async (c) => {
  return c.redirect("/admin/collections");
});

export default adminRoutes;
