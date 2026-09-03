import { test, expect, type Page } from "@playwright/test";

const ADMIN_HEADERS = { "X-Requested-With": "XMLHttpRequest" };

async function createTempCollection(page: Page, name: string) {
  const res = await page.request.post("/internal/api/admin/collections", {
    headers: ADMIN_HEADERS,
    data: {
      name,
      type: "base",
      fields: [{ name: "title", type: "text", required: true }],
    },
  });
  expect(res.ok(), `create collection failed: ${res.status()}`).toBeTruthy();
}

async function deleteTempCollection(page: Page, name: string) {
  try {
    await page.request.delete(`/internal/api/admin/collections/${name}`, {
      headers: ADMIN_HEADERS,
    });
  } catch {
    // Best effort cleanup.
  }
}

test.describe("Admin dashboard (SPA)", () => {
  // The shared storageState from the setup project already carries an admin
  // session cookie, so tests can navigate directly.

  test("collections panel lists collections", async ({ page }) => {
    await page.goto("/collections");
    await expect(
      page.getByRole("heading", { name: "Collections" }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder("Search collections..."),
    ).toBeVisible();
    // The panel shows collection entries, or the empty state when none exist.
    await expect(
      page
        .locator("[data-collection]")
        .first()
        .or(page.getByText("No collections found.")),
    ).toBeVisible();
  });

  test("create, edit and delete a record on a temp collection", async ({
    page,
  }) => {
    const name = `pwtmp_${Date.now().toString(36)}`;
    await createTempCollection(page, name);
    try {
      await page.goto(`/collections/${name}`);
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();

      // Create
      await page.locator('button[data-action="new-record"]').click();
      await expect(
        page.getByRole("heading", { name: "New Record" }),
      ).toBeVisible();
      await page.fill("#rf-title", "pw-first");
      await page.getByRole("button", { name: "Save Record" }).click();
      await expect(page.locator("td", { hasText: "pw-first" })).toBeVisible();

      // Edit
      await page.locator("td", { hasText: "pw-first" }).click();
      await expect(
        page.getByRole("heading", { name: "Edit Record" }),
      ).toBeVisible();
      await page.fill("#rf-title", "pw-second");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.locator("td", { hasText: "pw-second" })).toBeVisible();

      // Delete
      await page.locator("td", { hasText: "pw-second" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Delete record" }).click();
      await expect(page.getByText("No records found.")).toBeVisible();
    } finally {
      await deleteTempCollection(page, name);
    }
  });

  test("settings page loads", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "System" })).toBeVisible();
    await page.locator('[data-settings-tab="rate-limiter"]').click();
    await expect(page.getByText("Rate Limiting Rules")).toBeVisible();
  });

  test("unknown routes fall back to the collections shell", async ({
    page,
  }) => {
    await page.goto("/definitely-not-a-page");
    await expect(page).toHaveURL(/\/collections/);
  });
});
