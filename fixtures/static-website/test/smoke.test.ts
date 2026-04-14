import type { MiniflareInstance } from "@distilled.cloud/test-utils/miniflare";
import { createMiniflare } from "@distilled.cloud/test-utils/miniflare";
import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const client = path.resolve(root, "dist");

let miniflare: MiniflareInstance;

test.beforeAll(async () => {
  miniflare = await createMiniflare({
    modules: [
      {
        type: "ESModule",
        path: "index.js",
        contents: `export default { fetch: (request) => new Response("Not Found", { status: 404 }) }`,
      },
    ],
    assets: {
      directory: client,
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: false,
        debug: true,
      },
      assetConfig: {
        html_handling: "auto-trailing-slash",
        not_found_handling: "none",
        debug: true,
        has_static_routing: false,
      },
    },
  });
});

test.afterAll(async () => {
  await miniflare?.[Symbol.asyncDispose]();
});

test("renders the homepage", async ({ page }) => {
  const response = await page.goto(miniflare.url.toString());
  expect(response?.status()).toBe(200);
  await page.waitForLoadState("networkidle");

  const index = await page.content();
  expect(index).toMatchSnapshot("index.html");

  expect(await page.textContent("button.counter")).toBe("Count is 0");
  await page.click("button.counter");
  expect(await page.textContent("button.counter")).toBe("Count is 1");
});
