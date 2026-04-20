import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import collectionRoutes from "./collections.ts";
import customEndpointsRoutes from "./customEndpoints.ts";

const adminRoutes = new Hono();

adminRoutes.use("*", requireAuth);

adminRoutes.route("/collections", collectionRoutes);
adminRoutes.route("/custom-endpoints", customEndpointsRoutes);

export default adminRoutes;
