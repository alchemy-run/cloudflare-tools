import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

const SECRET = "s3cret-from-binding";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("server-renders the home page with platform.env", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#secret")).toHaveText(`secret:${SECRET}`);
      await expect(page.locator("#ctx")).toHaveText("ctx:yes");
      await expect(page.locator("#devalued")).toHaveText("devalued:{n:1}");
    });

    it("hydrates the client-interactive counter", async ({ page, server }) => {
      await page.goto(new URL("/counter", server.url).toString());
      await expect(page.locator("#count")).toHaveText("count:0");
      // wait for hydration before interacting (the effect flips the marker)
      await expect(page.locator("#increment")).toHaveAttribute("data-hydrated", "true");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:1");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:2");
    });

    it("serves the prerendered page", async ({ server }) => {
      const response = await server.fetch("/prerendered");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("this-page-is-prerendered");
    });

    it("serves static assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent: *");
    });

    it("runs the server endpoint (cookie, uuid, node:crypto, platform.env)", async ({ server }) => {
      const body = await server.fetchJson<{
        uuid: string;
        nodeUuid: string;
        cookie: string;
        secret: string;
      }>("/api/hello");
      expect(body.cookie).toBe("fixture=ok");
      expect(body.secret).toBe(SECRET);
      expect(body.uuid).toMatch(UUID_REGEX);
      expect(body.nodeUuid).toMatch(UUID_REGEX);
    });
  });
}
