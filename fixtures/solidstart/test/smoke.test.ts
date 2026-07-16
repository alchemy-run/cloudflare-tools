import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const method of Playwright.SERVER_METHODS) {
  test.describe(method, () => {
    const it = Playwright.make(method);

    it("renders the homepage", async ({ page, server }) => {
      const response = await page.goto(server.url.toString()).then(async (response) => {
        // solidstart has a bug where the first request is not always successful in dev mode.
        // Retry the request if it is not successful as a temporary workaround.
        if (response?.ok()) return response;
        return page.goto(server.url.toString());
      });
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      expect(await page.textContent("button.increment")).toBe("Clicks: 0");
      await page.click("button.increment");
      expect(await page.textContent("button.increment")).toBe("Clicks: 1");

      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("about.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });
    });
  });
}
