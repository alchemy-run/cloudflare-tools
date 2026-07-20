import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

/**
 * Requests target the server's real socket URL (not miniflare's
 * `dispatchFetch("http://localhost/…")` helper): production requests always
 * carry a real host:port, and OpenNext's middleware-rewrite handling
 * re-fetches the rewritten absolute URL — a port-less `localhost` host would
 * send that loopback fetch to port 80.
 */
const get = (server: { url: URL }, path: string) => fetch(new URL(path, server.url));

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("renders the SSR page", async ({ server }) => {
      const response = await get(server, "/");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("fixtures-nextjs SSR page");
      expect(body).toContain("rendered-at:");
    });

    it("serves the API route with the middleware header", async ({ server }) => {
      const response = await get(server, "/api/hello");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-fixture-middleware")).toBe("passed");
      const json = (await response.json()) as { hello: string };
      expect(json.hello).toBe("world");
    });

    it("rewrites via middleware", async ({ server }) => {
      const response = await get(server, "/mw-rewrite");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { hello: string; url: string };
      expect(json.hello).toBe("world");
      expect(json.url).toContain("/api/hello");
    });

    it("reads a Text binding through getCloudflareContext", async ({ server }) => {
      const response = await get(server, "/api/binding");
      expect(response.status).toBe(200);
      const json = (await response.json()) as { value: string | null };
      expect(json.value).toBe("hello-from-binding");
    });

    it("serves the ISR page from the prerendered cache", async ({ server }) => {
      const first = await get(server, "/isr");
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      const firstStamp = firstBody.match(/isr-rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
      expect(firstStamp).toBeDefined();

      // The prerendered payload serves as-is: repeated hits inside the
      // revalidate window return the same build-time stamp.
      const second = await get(server, "/isr");
      expect(second.status).toBe(200);
      const secondBody = await second.text();
      const secondStamp = secondBody.match(/isr-rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
      expect(secondStamp).toBe(firstStamp);
    });

    it("serves public/ static assets", async ({ server }) => {
      const response = await get(server, "/static.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello from a static asset");
    });

    it("serves _next/static client chunks", async ({ server }) => {
      const html = await (await get(server, "/")).text();
      const chunk = html.match(/\/_next\/static\/[^"'\s\\]+\.js/)?.[0];
      expect(chunk).toBeDefined();
      const response = await get(server, chunk!);
      expect(response.status).toBe(200);
    });

    it("hydrates the client-interactive page", async ({ page, server }) => {
      await page.goto(new URL("/counter", server.url.toString()).toString());
      await expect(page.getByTestId("count")).toHaveText("count:0");
      await page.getByTestId("increment").click();
      await expect(page.getByTestId("count")).toHaveText("count:1");
      await page.getByTestId("increment").click();
      await expect(page.getByTestId("count")).toHaveText("count:2");
    });
  });
}
