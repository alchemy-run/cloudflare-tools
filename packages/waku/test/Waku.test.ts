import * as Layer from "effect/Layer";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type * as ViteModule from "vite";
import { describe, expect, it } from "vitest";
import framework, {
  make,
  makeWakuConfigInput,
  makeWakuPluginOptions,
  WAKU_SERVER_ENTRY_MODULE,
  WAKU_SERVER_ENTRY_PATH,
} from "../src/index.ts";

const ADAPTER = "/project/node_modules/@distilled.cloud/waku/dist/adapter.js";
const WAKU_DIR = "/project/node_modules/waku";

const flatten = (plugins: Array<ViteModule.PluginOption> | undefined): Array<ViteModule.Plugin> =>
  ((plugins ?? []) as Array<unknown>)
    .flat(8)
    .filter(
      (plugin): plugin is ViteModule.Plugin =>
        typeof plugin === "object" && plugin !== null && "name" in plugin,
    );

describe("makeWakuPluginOptions", () => {
  it("pins main to waku's rsc worker entry and the rsc/ssr topology", () => {
    const options = makeWakuPluginOptions({ wakuDirectory: WAKU_DIR });
    expect(options.main).toBe(NodePath.join(WAKU_DIR, WAKU_SERVER_ENTRY_PATH));
    expect(options.viteEnvironments).toEqual({ entry: "rsc", children: ["ssr"] });
  });

  it("preserves user cloudflare options but overrides main and viteEnvironments", () => {
    const options = makeWakuPluginOptions({
      wakuDirectory: WAKU_DIR,
      pluginOptions: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        worker: { name: "fixtures-waku", bindings: [] },
        main: "/somewhere/else.ts",
        viteEnvironments: { entry: "ssr" },
      },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_als"]);
    expect(options.worker?.name).toBe("fixtures-waku");
    // waku-structural options always win: two rsc inputs require an explicit
    // main, and the worker must run in the rsc environment.
    expect(options.main).toBe(NodePath.join(WAKU_DIR, WAKU_SERVER_ENTRY_PATH));
    expect(options.viteEnvironments).toEqual({ entry: "rsc", children: ["ssr"] });
  });
});

describe("makeWakuConfigInput", () => {
  it("defaults unstable_adapter to the wrangler-free fork", () => {
    const config = makeWakuConfigInput({ adapterPath: ADAPTER, wakuDirectory: WAKU_DIR });
    expect(config.unstable_adapter).toBe(ADAPTER);
  });

  it("keeps a user-provided unstable_adapter", () => {
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      wakuDirectory: WAKU_DIR,
      userConfig: { unstable_adapter: "/custom/adapter.ts" },
    });
    expect(config.unstable_adapter).toBe("/custom/adapter.ts");
  });

  it("injects the cloudflare vite plugin ahead of user plugins", () => {
    const userPlugin: ViteModule.Plugin = { name: "user-plugin" };
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      wakuDirectory: WAKU_DIR,
      userConfig: { vite: { plugins: [userPlugin] } },
    });
    const plugins = flatten(config.vite?.plugins);
    const cloudflareIndex = plugins.findIndex((plugin) =>
      plugin.name.startsWith("distilled-cloudflare"),
    );
    const userIndex = plugins.findIndex((plugin) => plugin.name === "user-plugin");
    expect(cloudflareIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThan(cloudflareIndex);
  });

  it("omits the cloudflare vite plugin for the SSG preview config", () => {
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      wakuDirectory: WAKU_DIR,
      cloudflarePlugin: false,
    });
    const plugins = flatten(config.vite?.plugins);
    expect(plugins.some((plugin) => plugin.name.startsWith("distilled-cloudflare"))).toBe(false);
  });

  it("dedupes waku and hono so the adapter resolves the project's copies", () => {
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      wakuDirectory: WAKU_DIR,
      userConfig: { vite: { resolve: { dedupe: ["react", "waku"] } } },
    });
    expect(config.vite?.resolve?.dedupe).toEqual(["waku", "hono", "react"]);
  });

  it("applies the rsc/ssr optimizeDeps includes and neutral platform", () => {
    const config = makeWakuConfigInput({ adapterPath: ADAPTER, wakuDirectory: WAKU_DIR });
    const environments = config.vite?.environments as Record<string, ViteModule.EnvironmentOptions>;
    expect(environments.rsc?.optimizeDeps?.include).toContain("hono/tiny");
    expect(environments.ssr?.optimizeDeps?.include).toContain("waku > rsc-html-stream/server");
    expect(environments.rsc?.build?.rolldownOptions?.platform).toBe("neutral");
    expect(environments.ssr?.build?.rolldownOptions?.platform).toBe("neutral");
  });

  it("merges user environment config instead of clobbering it", () => {
    const config = makeWakuConfigInput({
      adapterPath: ADAPTER,
      wakuDirectory: WAKU_DIR,
      userConfig: {
        vite: {
          environments: {
            rsc: { optimizeDeps: { include: ["extra-dep"] } },
            custom: { optimizeDeps: { include: ["custom-dep"] } },
          },
        },
      },
    });
    const environments = config.vite?.environments as Record<string, ViteModule.EnvironmentOptions>;
    expect(environments.rsc?.optimizeDeps?.include).toEqual(["hono/tiny", "extra-dep"]);
    expect(environments.custom?.optimizeDeps?.include).toEqual(["custom-dep"]);
  });
});

describe("adapter fork", () => {
  it("drops the wrangler-writing build enhancer and never imports wrangler", async () => {
    const source = await NodeFsPromises.readFile(
      NodePath.resolve(import.meta.dirname, "../src/adapter.ts"),
      "utf8",
    );
    expect(source).toContain("buildEnhancers: []");
    expect(source).not.toContain("cloudflare-build-enhancer");
    expect(source).not.toMatch(/from\s+["']wrangler/);
    expect(source).not.toMatch(/import\(["']wrangler/);
  });
});

describe("framework factory", () => {
  it("default-exports a factory producing a Layer<Framework>", () => {
    expect(Layer.isLayer(framework({}))).toBe(true);
    expect(Layer.isLayer(make())).toBe(true);
  });

  it("pins the server entry to waku's rsc index module", () => {
    expect(WAKU_SERVER_ENTRY_MODULE).toBe(NodePath.join("server", "index.js"));
  });
});
