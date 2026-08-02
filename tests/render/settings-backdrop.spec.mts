import { expect, test } from "@playwright/test";

test("Cendre Settings keeps the app visible beneath a blurred scrim", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 20_000 });

  await page.getByRole("button", { name: "Settings" }).click();
  const overlay = page.locator(".settings-overlay");
  await expect(overlay).toBeVisible();

  await page
    .getByRole("group", { name: "Theme mode" })
    .getByRole("button", { name: "Dark" })
    .click();
  const darkThemeRow = page.locator(".settings-row").filter({ hasText: "Dark theme" });
  await darkThemeRow.locator(".settings-select__trigger").click();
  await darkThemeRow.getByRole("option", { name: "Cendre Hard" }).click();

  const backdrop = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter,
    };
  });

  expect(backdrop.backgroundColor).toBe("rgba(15, 12, 10, 0.7)");
  expect(backdrop.backdropFilter).toContain("blur(");
});
