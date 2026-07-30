import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

const SECRET = "s3cret-from-binding";

// The dev-mode specs are written against the INTENDED dev contract
// (`event.context.cloudflare` served through the platform bridge, same shape
// as production) but the Nuxt dev transport lands in the next phase — until
// then only the live suite registers. scripts/e2e.mjs prints the pending
// note; set NUXT_DEV_ENABLE=1 to run the dev suite.
const modes: ReadonlyArray<Playwright.ServerMethod> = process.env.NUXT_DEV_ENABLE
  ? Playwright.SERVER_METHODS
  : ["live"];

for (const mode of modes) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("server-renders the home page with the cloudflare env binding", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("page-marker")).toHaveText("NUXT_FIXTURE");
      // `runtimeConfig.public.fixtureMarker` comes from the user's own
      // nuxt.config.ts — proves the config file loaded natively.
      await expect(page.getByTestId("config-marker")).toHaveText("user-nuxt-config-loaded");
      // Read during SSR from event.context.cloudflare.env.
      await expect(page.getByTestId("env-secret")).toHaveText(`secret:${SECRET}`);
    });

    it("hydrates the client-interactive counter", async ({ page, server }) => {
      await page.goto(new URL("/counter", server.url).toString());
      await expect(page.locator("#count")).toHaveText("count:0");
      // wait for hydration before interacting (onMounted flips the marker)
      await expect(page.locator("#increment")).toHaveAttribute("data-hydrated", "true");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:1");
      await page.click("#increment");
      await expect(page.locator("#count")).toHaveText("count:2");
    });

    it("serves the prerendered page from the assets layer", async ({ server }) => {
      const response = await server.fetch("/prerendered");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("this-page-is-prerendered");
    });

    it("serves static assets", async ({ server }) => {
      const response = await server.fetch("/robots.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("User-agent: *");
    });

    it("runs the API route with the cloudflare runtime context", async ({ server }) => {
      const body = await server.fetchJson<{
        marker: string;
        secret: string | null;
        hasWaitUntil: boolean;
      }>("/api/hello");
      expect(body.marker).toBe("api-route-ok");
      expect(body.secret).toBe(SECRET);
      expect(body.hasWaitUntil).toBe(true);
    });

    it("increments the Counter DO exported through the entry/exports seam", async ({ server }) => {
      // Plain HTTP fetch (not `server.fetch`): the live-mode dispatchFetch
      // wrapper drops RequestInit, losing the POST method.
      const post = async (): Promise<number> => {
        const response = await fetch(new URL("/api/counter", server.url), { method: "POST" });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { count: number };
        return body.count;
      };

      const first = await post();
      const second = await post();
      // Relative assertion: DO storage may persist across runs locally.
      expect(second).toBe(first + 1);

      // GET observes the state written by the POSTs — same DO instance.
      const read = await fetch(new URL("/api/counter", server.url));
      expect(read.status).toBe(200);
      expect(((await read.json()) as { count: number }).count).toBe(second);
    });
  });
}
