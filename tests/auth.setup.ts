import { test as setup, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, AUTH_FILE } from "./helpers";

// Logs in once per test run; dependent projects reuse the stored session so
// the suite does not trip the /internal/api/auth/login rate limit.
setup("authenticate as admin", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#login-email", ADMIN_EMAIL);
  await page.fill("#login-password", ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/collections/);
  await page.context().storageState({ path: AUTH_FILE });
});
