import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

// NOTE: this suite is written against the INTENDED behavior of the
// static-output path: a pure `output: "static"` Astro site deploys
// ASSETS-ONLY (no worker, `BuildOutput.serverModules` undefined/empty). It
// is gated behind ASTRO_STATIC_ENABLE=1 until the assets-only wave lands —
// see scripts/e2e.mjs and README.md.
for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("serves the prerendered home page", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#title")).toHaveText("Astro Static Fixture");
      await expect(page.locator("#mode")).toHaveText("static");
    });

    it("navigates the whole site through the nav (sitemap-ish)", async ({ page, server }) => {
      await page.goto(server.url.toString());
      await page.locator("#nav-about").click();
      await expect(page.locator("#title")).toHaveText("About");
      await page.locator("#nav-blog").click();
      await expect(page.locator("#title")).toHaveText("Blog");
      await expect(page.locator("#post-list li")).toHaveCount(2);
      await page.locator("#nav-first-post").click();
      await expect(page.locator("#slug")).toHaveText("first-post");
      await page.locator("#nav-second-post").click();
      await expect(page.locator("#slug")).toHaveText("second-post");
      await page.locator("#nav-home").click();
      await expect(page.locator("#title")).toHaveText("Astro Static Fixture");
    });

    it("serves getStaticPaths-enumerated routes", async ({ server }) => {
      const first = await server.fetch("/blog/first-post/");
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("First post");

      const second = await server.fetch("/blog/second-post/");
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("Second post");
    });

    it("hydrates the client-side island", async ({ page, server }) => {
      await page.goto(new URL("/counter/", server.url).toString());
      // The prerendered HTML says "no"; the bundled client script flips it.
      await expect(page.locator("#hydrated")).toHaveText("yes");
      await expect(page.locator("#count")).toHaveText("0");
      await page.locator("#increment").click();
      await page.locator("#increment").click();
      await expect(page.locator("#count")).toHaveText("2");
    });

    it("serves public assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent");
    });

    it("returns the custom 404 page for unmatched routes", async ({ server }) => {
      const response = await server.fetch("/definitely-not-a-route");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Page not found");
    });
  });
}

// Live-only assertions: the production artifact itself.
test.describe("live", () => {
  const it = Playwright.make("live");

  it("serves build-frozen HTML (no per-request rendering)", async ({ server }) => {
    // `#built-at` is stamped at BUILD time; two requests must be
    // byte-identical. (Dev renders on demand by design, so live-only.)
    const first = await (await server.fetch("/")).text();
    const second = await (await server.fetch("/")).text();
    expect(first).toBe(second);
    expect(first).toContain('id="built-at"');
  });

  // THE POINT of this fixture: a fully-static build must be assets-only.
  // This is the enablement target — the audit found the integration
  // currently emits a full worker for `output: "static"`.
  it("build output contains NO server modules (assets-only)", async ({ server }) => {
    // The harness builds before serving live mode, so dist/build.json exists.
    void server;
    const raw = await readFile(new URL("../dist/build.json", import.meta.url), "utf8");
    const build = JSON.parse(raw) as { serverModules?: Array<{ name: string }> | undefined };
    expect(build.serverModules ?? []).toEqual([]);
  });
});
