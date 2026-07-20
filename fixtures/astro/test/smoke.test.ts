import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

const FIXTURE_VALUE = "hello-from-astro-binding";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("renders the SSR page with the binding and hydrates the client script", async ({
      page,
      server,
    }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#mode")).toHaveText("on-demand");
      await expect(page.locator("#binding")).toHaveText(FIXTURE_VALUE);
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot("index.png", {
        animations: "disabled",
        maxDiffPixelRatio: 0.03,
      });

      const button = page.locator("#counter");
      await expect(button).toHaveText("count is 0");
      await button.click();
      await expect(button).toHaveText("count is 1");
    });

    it("serves the prerendered page", async ({ server }) => {
      const response = await server.fetch("/about/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('id="mode"');
      expect(html).toContain("prerendered");
    });

    it("reads the binding from the API route", async ({ server }) => {
      const json = await server.fetchJson<{ value: string | null; hasAssetsBinding: boolean }>(
        "/api/hello",
      );
      expect(json).toMatchObject({ value: FIXTURE_VALUE, hasAssetsBinding: true });
    });

    it("serves public assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent");
    });

    it("falls back through ASSETS to the 404 page", async ({ server }) => {
      const response = await server.fetch("/definitely-not-a-route");
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    });
  });
}
