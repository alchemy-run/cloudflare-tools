import { createMiniflare, type MiniflareInstance } from "@distilled.cloud/test-utils/miniflare";
import { miniflareModulesFromDirectory } from "@distilled.cloud/test-utils/miniflare-module";
import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const client = path.resolve(root, "dist/client");

// The Worker runs in the `rsc` environment and loads the `ssr` environment at
// runtime via a relative `../../ssr/index.js` import, so both output
// directories ship as a single Miniflare module set under matching prefixes.
const WORKER_ENTRY = "rsc/entry.worker.js";

let miniflare: MiniflareInstance;

test.beforeAll(async () => {
  const [rsc, ssr] = await Promise.all([
    miniflareModulesFromDirectory(path.resolve(root, "dist/rsc"), "rsc"),
    miniflareModulesFromDirectory(path.resolve(root, "dist/ssr"), "ssr"),
  ]);
  const modules = [...rsc, ...ssr];
  const entryIndex = modules.findIndex((module) => module.path === WORKER_ENTRY);
  if (entryIndex === -1) {
    throw new Error(`Worker entry "${WORKER_ENTRY}" not found in build output`);
  }
  // Miniflare treats the first module as the Worker entrypoint.
  modules.unshift(modules.splice(entryIndex, 1)[0]);

  miniflare = await createMiniflare({
    modules,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
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

test("renders the homepage and hydrates client routes", async ({ page }) => {
  const response = await page.goto(miniflare.url.toString());
  expect(response?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
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

  expect(await page.textContent("button.counter")).toBe("Count is 0");
  await page.click("button.counter");
  expect(await page.textContent("button.counter")).toBe("Count is 1");
});
