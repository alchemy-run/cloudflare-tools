import { createMiniflare } from "@distilled.cloud/test-utils/miniflare";
import { miniflareModulesFromDirectory } from "@distilled.cloud/test-utils/miniflare-module";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const server = path.resolve(root, "dist/server");
const client = path.resolve(root, "dist/client");
const modules = await miniflareModulesFromDirectory(server);

const miniflare = await createMiniflare({
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

afterAll(async () => {
  await miniflare[Symbol.asyncDispose]();
});

it("renders the homepage", async () => {
  const html = await miniflare.fetchText("/");
  expect(html).toMatchSnapshot();
});
