import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, loginViaUi } from "./helpers";

// These tests exercise the unauthenticated flows, so ignore the shared
// admin session created by the setup project.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Auth (SPA)", () => {
  test("unauthenticated visitors are redirected to /login", async ({
    page,
  }) => {
    await page.goto("/collections");
    await expect(page).toHaveURL(/\/login/);
  });

  test("root redirects to /login when not authenticated", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("login with bad credentials shows an error", async ({ page }) => {
    await page.goto("/login");
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", "definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Invalid credentials.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("login with valid credentials lands on the collections shell", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.fill("#login-email", ADMIN_EMAIL);
    await page.fill("#login-password", ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/collections/);
    await expect(
      page.getByRole("heading", { name: "Collections" }),
    ).toBeVisible();
  });

  test("logout returns to the login page", async ({ page }) => {
    await loginViaUi(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);

    // The session cookie is gone: protected routes redirect again.
    await page.goto("/collections");
    await expect(page).toHaveURL(/\/login/);
  });
});
