import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const backend = process.env.BACKEND_URL || "http://localhost:8080";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/internal": {
        target: backend,
        changeOrigin: true,
      },
      // Trailing slash is required: bare "/api" would also match SPA routes
      // like /api-tester and send them to the backend instead of the SPA.
      "/api/": {
        target: backend,
        changeOrigin: true,
        // WebSocket upgrade for /api/logs/stream.
        ws: true,
      },
      "/health": {
        target: backend,
        changeOrigin: true,
      },
      "/setup-db": {
        target: backend,
        changeOrigin: true,
      },
    },
  },
});
