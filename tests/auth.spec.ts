import { test, expect } from '@playwright/test';

test.describe('Auth UI Tests', () => {
  test('Redirects to login if not authenticated', async ({ page }) => {
    await page.goto('http://127.0.0.1:8080/admin');
    await expect(page).toHaveURL('http://127.0.0.1:8080/login');
  });

  test('Fails login with bad credentials and shows error', async ({ page }) => {
    await page.goto('http://127.0.0.1:8080/login');
    await page.fill('input[name="email"]', 'admin@grescale.local');
    await page.fill('input[name="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    // HTMX places the error in #login-error
    const errorMsg = page.locator('#login-error');
    await expect(errorMsg).toContainText('Invalid credentials');
  });
});
