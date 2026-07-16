import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const method of Playwright.SERVER_METHODS) {
  test.describe(method, () => {
    const it = Playwright.make(method);

    it("renders the homepage", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      expect(await page.textContent("button.counter")).toBe("Count is 0");
      await page.click("button.counter");
      expect(await page.textContent("button.counter")).toBe("Count is 1");
    });
  });
}
