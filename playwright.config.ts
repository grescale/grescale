import { defineConfig, devices } from "@playwright/test";

const BACKEND_PORT = 8090;
const VITE_PORT = 5173;

// When PLAYWRIGHT_BASE_URL is set, tests run against that already-running
// server (e.g. the production backend serving the built SPA) and no
// webServer processes are spawned.
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;

const AUTH_STATE = "tests/.auth/admin.json";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  retries: 0,
  workers: 1,
  use: {
    baseURL: externalBaseURL ?? `http://127.0.0.1:${VITE_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: "auth.setup.ts" },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : [
        {
          command: `PORT=${BACKEND_PORT} bun run src/index.ts`,
          url: `http://127.0.0.1:${BACKEND_PORT}/health`,
          reuseExistingServer: !process.env.CI,
        },
        {
          command: `BACKEND_URL=http://127.0.0.1:${BACKEND_PORT} npm --prefix web run dev -- --port ${VITE_PORT} --strictPort`,
          url: `http://127.0.0.1:${VITE_PORT}`,
          reuseExistingServer: !process.env.CI,
        },
      ],
});
