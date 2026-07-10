import { createMiniflareFromRolldown } from "@distilled.cloud/test-utils/miniflare";
import type * as vite from "vite";
import { assert, describe, expect, it } from "vitest";
import { optionsPlugin } from "../src/plugins/options.js";
import { buildFixture } from "./utils/build-fixture";

describe("worker entry", () => {
  it("serves a worker with a default export", async () => {
    const built = await buildFixture({ fixture: "worker-entry/with-default.ts" });
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });
    expect(await miniflare.fetchJson<{ message: string }>("/")).toEqual({ message: "hello" });
  });

  it("throws an actionable error when the entry has no default export", async () => {
    // e.g. React Router's `virtual:react-router/server-build` — deploying
    // `export default {}` would fail Cloudflare's upload validation with the
    // opaque "The uploaded script has no registered event handlers".
    const built = await buildFixture({ fixture: "worker-entry/no-default.ts" });
    await expect(
      createMiniflareFromRolldown(built.output, {
        compatibilityDate: "2025-07-01",
      }),
    ).rejects.toThrow(/has no default export/);
  });

  it("allows a default-less entry that exports a Durable Object class", async () => {
    const built = await buildFixture({ fixture: "worker-entry/named-durable-object.ts" });
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
      durableObjects: { COUNTER: "Counter" },
    });
    // The worker instantiates without throwing; the DO class is reachable.
    expect(miniflare.url).toBeDefined();
  });
});

describe("vite worker entry resolution", () => {
  const callConfig = async (userConfig: vite.UserConfig) => {
    const plugin = optionsPlugin.vite({ compatibilityDate: "2025-07-01" });
    assert(typeof plugin.config === "function", "plugin.config is not a function");
    return (await plugin.config.call({ meta: {} } as never, userConfig, {
      command: "build",
      mode: "production",
    } as vite.ConfigEnv)) as vite.UserConfig;
  };

  it("resolves a relative ssr input against the vite root", async () => {
    // The user entry is resolved with no importer, so without this a relative
    // input resolves against `process.cwd()` — the wrong base when the build
    // runs outside the project root (e.g. a monorepo infra package).
    const config = await callConfig({
      root: "/project",
      environments: {
        ssr: { build: { rollupOptions: { input: "./workers/app.ts" } } },
      },
    });
    expect(config.environments?.ssr?.build?.rollupOptions?.input).toEqual({
      app: "\0distilled:worker-entry:/project/workers/app.ts",
    });
  });

  it("leaves virtual module inputs untouched", async () => {
    const config = await callConfig({
      root: "/project",
      environments: {
        ssr: {
          build: { rollupOptions: { input: "virtual:react-router/server-build" } },
        },
      },
    });
    expect(config.environments?.ssr?.build?.rollupOptions?.input).toEqual({
      "server-build": "\0distilled:worker-entry:virtual:react-router/server-build",
    });
  });
});
