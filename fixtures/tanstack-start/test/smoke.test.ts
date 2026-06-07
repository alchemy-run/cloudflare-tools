import { createMiniflare, type MiniflareInstance } from "@distilled.cloud/test-utils/miniflare";
import { miniflareModulesFromDirectory } from "@distilled.cloud/test-utils/miniflare-module";
import { expect, test } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const server = path.resolve(root, "dist/server");
const client = path.resolve(root, "dist/client");

let miniflare: MiniflareInstance;

test.beforeAll(async () => {
  const modules = await miniflareModulesFromDirectory(server);
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
    bindings: {
      TEST_POSTGRES_URL: process.env.TEST_POSTGRES_URL!,
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

test("fetches database", async () => {
  const response = await miniflare.fetchJson<[{ "?column?": number }]>("/api/db");
  expect(response).toMatchObject([{ "?column?": 1 }]);
});
