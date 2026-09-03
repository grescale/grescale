import { expect } from "@playwright/test";

export const ADMIN_EMAIL = "gaganbiswas.me1@gmail.com";
export const ADMIN_PASSWORD = "7044Gagan*";

export const AUTH_FILE = "tests/.auth/admin.json";

/** Log in through the SPA login page and land on the collections shell. */
export async function loginViaUi(page: any) {
  await page.goto("/login");
  await page.fill("#login-email", ADMIN_EMAIL);
  await page.fill("#login-password", ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/collections/);
}
