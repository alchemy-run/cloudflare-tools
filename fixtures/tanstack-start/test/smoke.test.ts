import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("renders the homepage", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("about.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });
    });

    it("fetches database", async ({ server }) => {
      const response = await server.fetchJson<[{ "?column?": number }]>("/api/db");
      expect(response).toMatchObject([{ "?column?": 1 }]);
    });

    it("fetches WASM", async ({ server }) => {
      const response = await server.fetchJson<{ result: number }>("/api/wasm");
      expect(response).toMatchObject({ result: 3 });
    });
  });
}
