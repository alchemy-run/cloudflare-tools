import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    it("SSR renders the dynamic page with the Text binding", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("page-marker")).toHaveText("PAGE_MARKER");
      await expect(page.getByTestId("layout-marker")).toHaveText("LAYOUT_MARKER");
      // Read at request time from `cloudflare:workers` env — proves the rsc
      // environment runs against the worker runtime in both modes.
      await expect(page.getByTestId("env-message")).toHaveText("MESSAGE=hello-from-binding");
    });

    it("hydrates the client component", async ({ page, server }) => {
      await page.goto(server.url.toString());
      const counter = page.getByTestId("counter");
      await expect(counter).toHaveText("count: 0");
      // The first click can land before hydration attaches the listener;
      // retry until the click observably increments.
      await expect(async () => {
        await counter.click();
        await expect(counter).toHaveText(/count: [1-9]\d*/, { timeout: 500 });
      }).toPass();
    });

    it("client-navigates to the static page", async ({ page, server }) => {
      await page.goto(server.url.toString());
      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await expect(page.getByTestId("about-marker")).toHaveText("ABOUT_STATIC_MARKER");
    });

    it("serves the static asset", async ({ server }) => {
      const response = await server.fetch("/hello.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello from public/");
    });

    it("round-trips a server action (form mutation) through the worker", async ({
      page,
      server,
    }) => {
      await page.goto(server.url.toString());
      await page.fill("[data-testid=greet-name]", "Waku");
      // The submit can land before hydration attaches the action; retry
      // until the round-trip observably completes. The MESSAGE suffix proves
      // the action executed inside the worker runtime with bindings.
      await expect(async () => {
        await page.click("[data-testid=greet-submit]");
        await expect(page.getByTestId("greet-output")).toHaveText(
          "Hello, Waku! MESSAGE=hello-from-binding",
          { timeout: 1_000 },
        );
      }).toPass();
    });

    it("SSRs the dynamic route with a path param", async ({ page, server }) => {
      const response = await page.goto(new URL("/items/42", server.url).toString());
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("item-marker")).toHaveText("ITEM_MARKER id=42");
      await expect(page.getByTestId("item-env")).toHaveText("MESSAGE=hello-from-binding");
    });

    it("serves the API route (GET) from the worker", async ({ server }) => {
      const response = await server.fetch("/echo");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: "hello-from-binding" });
    });

    it("round-trips a POST through the API route", async ({ server }) => {
      // Plain HTTP (not `server.fetch`): the live-mode dispatchFetch wrapper
      // in the harness currently drops the RequestInit, losing POST bodies
      // (packages/tools/test/src/miniflare.ts `fetch(path)` has no init
      // parameter). Both modes listen on a real socket, so this exercises
      // the same worker path.
      const response = await fetch(new URL("/echo", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ping: "pong" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        echoed: { ping: "pong" },
        message: "hello-from-binding",
      });
    });

    it("keeps layout client state across client navigation", async ({ page, server }) => {
      await page.goto(server.url.toString());
      const counter = page.getByTestId("nav-counter");
      await expect(counter).toHaveText("nav-count: 0");
      await expect(async () => {
        await counter.click();
        await expect(counter).toHaveText(/nav-count: [1-9]\d*/, { timeout: 500 });
      }).toPass();
      const count = await counter.textContent();
      await page.click("a[href='/about']");
      await page.waitForURL("**/about");
      await expect(page.getByTestId("about-marker")).toHaveText("ABOUT_STATIC_MARKER");
      // The layout stays mounted through waku's client navigation, so the
      // client component's state survives the page swap.
      await expect(counter).toHaveText(count!);
    });
  });
}

// SSG output only exists in the production build: `dist/public` contains the
// prerendered HTML and RSC payload, served by the assets layer in live mode.
test.describe("live ssg", () => {
  const it = Playwright.make("live");

  it("serves the SSG page from assets", async ({ server }) => {
    const response = await server.fetch("/about");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ABOUT_STATIC_MARKER");
  });

  it("serves the SSG RSC payload from assets", async ({ server }) => {
    const response = await server.fetch("/RSC/R/about.txt");
    expect(response.status).toBe(200);
  });
});
