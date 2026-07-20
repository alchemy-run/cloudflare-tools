import type { AstroIntegration } from "astro";
import * as Layer from "effect/Layer";
import * as NodeFsPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type * as ViteModule from "vite";
import { describe, expect, it } from "vitest";
import { createConfigPlugin } from "../src/config-plugin.ts";
import framework, {
  distilledCloudflare,
  IMAGE_PASSTHROUGH_ENDPOINT,
  make,
  makeAstroInlineConfig,
  makeIntegrationPluginOptions,
  NODE_ENVIRONMENTS,
  SERVER_ENTRYPOINT,
} from "../src/index.ts";

const ROOT = "/project";

const flatten = (plugins: unknown): Array<ViteModule.Plugin> =>
  ((plugins ?? []) as Array<unknown>)
    .flat(Infinity)
    .filter(
      (plugin): plugin is ViteModule.Plugin =>
        typeof plugin === "object" && plugin !== null && "name" in plugin,
    );

type CapturedConfig = {
  build?: { redirects?: boolean };
  vite?: { plugins?: unknown };
  image?: {
    service?: { entrypoint?: string | URL };
    endpoint?: { entrypoint?: string | URL };
  };
};

const runConfigSetup = (
  integration: AstroIntegration,
  command: "dev" | "build" | "sync",
): CapturedConfig => {
  let captured: CapturedConfig | undefined;
  const hook = integration.hooks["astro:config:setup"];
  if (!hook) throw new Error("astro:config:setup hook missing");
  void hook({
    command,
    config: { vite: {}, image: {} },
    updateConfig: (config: unknown) => {
      captured = config as CapturedConfig;
      return {} as never;
    },
  } as never);
  if (!captured) throw new Error("updateConfig was not called");
  return captured;
};

const objectHook = <A extends Array<unknown>, R>(
  hook: unknown,
): ((this: unknown, ...args: A) => R) => {
  if (typeof hook === "function") return hook as never;
  if (typeof hook === "object" && hook !== null && "handler" in hook) {
    return (hook as { handler: (this: unknown, ...args: A) => R }).handler;
  }
  throw new Error("hook is neither a function nor an object hook");
};

describe("makeIntegrationPluginOptions", () => {
  it("pins main, the ssr entry environment, and the node skipEnvironments", () => {
    const options = makeIntegrationPluginOptions();
    expect(options.main).toBe(SERVER_ENTRYPOINT);
    expect(options.viteEnvironments).toEqual({ entry: "ssr" });
    expect(options.skipEnvironments).toEqual([...NODE_ENVIRONMENTS]);
  });

  it("preserves user cloudflare options but overrides the structural ones", () => {
    const options = makeIntegrationPluginOptions({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      worker: { name: "fixtures-astro", bindings: [] },
      main: "/somewhere/else.ts",
      viteEnvironments: { entry: "rsc" },
      skipEnvironments: ["custom", "prerender"],
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(options.worker?.name).toBe("fixtures-astro");
    // Astro-structural options always win: the worker entry is the vendored
    // server entrypoint and Astro pins the worker environment name to "ssr".
    expect(options.main).toBe(SERVER_ENTRYPOINT);
    expect(options.viteEnvironments).toEqual({ entry: "ssr" });
    expect(options.skipEnvironments).toEqual(["astro", "prerender", "custom"]);
  });
});

describe("makeAstroInlineConfig", () => {
  it("pins root, configFile: false, and the adapter; defaults output to server", () => {
    const config = makeAstroInlineConfig({ root: ROOT });
    expect(config.root).toBe(ROOT);
    expect(config.configFile).toBe(false);
    expect(config.output).toBe("server");
    expect((config.adapter as AstroIntegration).name).toBe("@distilled.cloud/astro");
  });

  it("merges user config but keeps the pinned fields", () => {
    const config = makeAstroInlineConfig({
      root: ROOT,
      userConfig: {
        site: "https://example.com",
        output: "static",
        root: "/elsewhere",
        configFile: "/elsewhere/astro.config.ts",
        devToolbar: { enabled: false },
      },
    });
    expect(config.site).toBe("https://example.com");
    expect(config.output).toBe("static");
    expect(config.devToolbar).toEqual({ enabled: false });
    expect(config.root).toBe(ROOT);
    expect(config.configFile).toBe(false);
    expect((config.adapter as AstroIntegration).name).toBe("@distilled.cloud/astro");
  });

  it("merges the dev port into server options", () => {
    const config = makeAstroInlineConfig({
      root: ROOT,
      userConfig: { server: { host: "127.0.0.1" } },
      port: 3102,
    });
    expect(config.server).toEqual({ host: "127.0.0.1", port: 3102 });
  });

  it("appends extra vite plugins after the user's", () => {
    const userPlugin: ViteModule.Plugin = { name: "user-plugin" };
    const collectorPlugin: ViteModule.Plugin = { name: "alchemy:build-output" };
    const config = makeAstroInlineConfig({
      root: ROOT,
      userConfig: { vite: { plugins: [userPlugin] } },
      extraVitePlugins: [collectorPlugin],
    });
    const plugins = flatten(config.vite?.plugins);
    const names = plugins.map((plugin) => plugin.name);
    expect(names.indexOf("user-plugin")).toBeLessThan(names.indexOf("alchemy:build-output"));
  });
});

describe("distilledCloudflare astro:config:setup", () => {
  it("injects the cloudflare plugins, config plugin, and dev prerender middleware in dev", () => {
    const captured = runConfigSetup(distilledCloudflare(), "dev");
    const plugins = flatten(captured.vite?.plugins);
    const names = plugins.map((plugin) => plugin.name);
    expect(names).toContain("@distilled.cloud/astro:dev-server-prerender-middleware");
    expect(names).toContain("@distilled.cloud/astro:cf-imports");
    expect(names).toContain("@distilled.cloud/astro:environment");
    expect(names).toContain("@distilled.cloud/astro:cf-externals");
    expect(names).toContain("virtual:astro-cloudflare:config");
    const cloudflare = plugins.filter((plugin) => plugin.name.startsWith("distilled-cloudflare"));
    expect(cloudflare.length).toBeGreaterThan(0);
    // Dev keeps the dev server hooks intact.
    expect(cloudflare.some((plugin) => plugin.configureServer !== undefined)).toBe(true);
    expect(captured.build?.redirects).toBe(false);
  });

  it("strips configureServer from the cloudflare plugins during build/sync typegen", () => {
    for (const command of ["build", "sync"] as const) {
      const captured = runConfigSetup(distilledCloudflare(), command);
      const plugins = flatten(captured.vite?.plugins);
      const names = plugins.map((plugin) => plugin.name);
      expect(names).not.toContain("@distilled.cloud/astro:dev-server-prerender-middleware");
      const cloudflare = plugins.filter((plugin) => plugin.name.startsWith("distilled-cloudflare"));
      expect(cloudflare.length).toBeGreaterThan(0);
      expect(cloudflare.every((plugin) => plugin.configureServer === undefined)).toBe(true);
    }
  });

  it("configures the passthrough image service with the phase-specific endpoint", () => {
    const dev = runConfigSetup(distilledCloudflare(), "dev");
    expect(dev.image?.service?.entrypoint).toBeDefined();
    expect(dev.image?.endpoint).toEqual({ entrypoint: "astro/assets/endpoint/generic" });
    const build = runConfigSetup(distilledCloudflare(), "build");
    expect(build.image?.endpoint).toEqual({ entrypoint: IMAGE_PASSTHROUGH_ENDPOINT });
  });

  it("pre-bundles the server environments in dev but disables discovery during typegen", () => {
    const findEnvironmentPlugin = (command: "dev" | "build") => {
      const captured = runConfigSetup(distilledCloudflare(), command);
      const plugin = flatten(captured.vite?.plugins).find(
        (candidate) => candidate.name === "@distilled.cloud/astro:environment",
      );
      if (!plugin) throw new Error("environment plugin missing");
      return objectHook<
        [string, ViteModule.EnvironmentOptions],
        { optimizeDeps?: ViteModule.DepOptimizationOptions } | undefined
      >(plugin.configEnvironment);
    };

    const dev = findEnvironmentPlugin("dev");
    expect(dev.call({}, "ssr", {})?.optimizeDeps?.include).toContain(SERVER_ENTRYPOINT);
    expect(dev.call({}, "client", {})?.optimizeDeps?.include).toContain(
      "astro/runtime/client/dev-toolbar/entrypoint.js",
    );
    expect(dev.call({}, "custom", {})).toBeUndefined();
    // Environments already configured with an explicit (no-discovery)
    // optimizer are left alone.
    expect(dev.call({}, "ssr", { optimizeDeps: { noDiscovery: true } })).toBeUndefined();

    const typegen = findEnvironmentPlugin("build");
    expect(typegen.call({}, "ssr", {})?.optimizeDeps).toEqual({ noDiscovery: true, include: [] });
  });

  it("scopes cf-externals to the worker-resolved server environments", () => {
    const captured = runConfigSetup(distilledCloudflare(), "build");
    const plugin = flatten(captured.vite?.plugins).find(
      (candidate) => candidate.name === "@distilled.cloud/astro:cf-externals",
    );
    if (!plugin) throw new Error("cf-externals plugin missing");
    const applies = plugin.applyToEnvironment as (environment: { name: string }) => boolean;
    expect(applies({ name: "ssr" })).toBe(true);
    expect(applies({ name: "prerender" })).toBe(true);
    expect(applies({ name: "client" })).toBe(false);
    const config = objectHook<[{ ssr?: { external?: unknown } }], void>(plugin.config);
    const conf = { ssr: { external: ["some-dep"] } };
    config.call({}, conf);
    expect(conf.ssr.external).toBeUndefined();
  });
});

describe("distilledCloudflare astro:config:done", () => {
  it("registers the adapter without a preview entrypoint", () => {
    let adapter: Record<string, unknown> | undefined;
    const integration = distilledCloudflare();
    const hook = integration.hooks["astro:config:done"];
    if (!hook) throw new Error("astro:config:done hook missing");
    void hook({
      buildOutput: "server",
      setAdapter: (value: unknown) => {
        adapter = value as Record<string, unknown>;
      },
    } as never);
    expect(adapter?.name).toBe("@distilled.cloud/astro");
    expect(adapter?.previewEntrypoint).toBeUndefined();
    expect(adapter?.serverEntrypoint).toBeUndefined();
    expect(adapter?.adapterFeatures).toMatchObject({
      buildOutput: "server",
      middlewareMode: "classic",
      preserveBuildClientDir: true,
      preserveBuildServerDir: true,
    });
  });
});

describe("distilledCloudflare astro:build:setup", () => {
  it("applies the server-target vite tweaks", () => {
    const integration = distilledCloudflare();
    const hook = integration.hooks["astro:build:setup"];
    if (!hook) throw new Error("astro:build:setup hook missing");
    const viteConfig: Record<string, any> = {};
    void hook({ vite: viteConfig, target: "server" } as never);
    expect(viteConfig.ssr?.noExternal).toBe(true);
    expect(viteConfig.build?.rolldownOptions?.external).toEqual(["sharp"]);
    expect(viteConfig.build?.rolldownOptions?.output?.banner).toContain("globalThis.process");
    expect(viteConfig.define?.["globalThis.__ASTRO_IMAGES_BINDING_NAME"]).toBe('"IMAGES"');

    const clientConfig: Record<string, any> = {};
    void hook({ vite: clientConfig, target: "client" } as never);
    expect(clientConfig.ssr).toBeUndefined();
  });
});

describe("config plugin (virtual:astro-cloudflare:config)", () => {
  const plugin = createConfigPlugin({
    sessionKVBindingName: "SESSION",
    compileImageConfig: null,
    cacheProviderEnabled: false,
  });

  it("resolves and loads the virtual module", () => {
    const resolveId = objectHook<[string], string>(plugin.resolveId);
    const resolved = resolveId.call({}, "virtual:astro-cloudflare:config");
    expect(resolved).toBe("\0virtual:astro-cloudflare:config");

    const load = objectHook<[string], string>(plugin.load);
    const code = load.call({ environment: { name: "ssr" } }, resolved);
    expect(code).toContain('export const sessionKVBindingName = "SESSION"');
    expect(code).toContain("export const compileImageConfig = null");
    expect(code).toContain("export const cacheProviderEnabled = false");
    expect(code).toContain("export const isPrerender = false");
  });

  it("marks isPrerender only in the prerender environment", () => {
    const load = objectHook<[string], string>(plugin.load);
    const code = load.call(
      { environment: { name: "prerender" } },
      "\0virtual:astro-cloudflare:config",
    );
    expect(code).toContain("export const isPrerender = true");
  });
});

describe("vendored runtime purity", () => {
  it("never imports wrangler, @astrojs/cloudflare, or @cloudflare/vite-plugin", async () => {
    const runtimeDir = NodePath.resolve(import.meta.dirname, "../src/runtime");
    const entries = await NodeFsPromises.readdir(runtimeDir, {
      recursive: true,
      withFileTypes: true,
    });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => NodePath.join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await NodeFsPromises.readFile(file, "utf8");
      expect(source, file).not.toMatch(/["']wrangler["']|["']wrangler\//);
      expect(source, file).not.toMatch(/["']@astrojs\/cloudflare/);
      expect(source, file).not.toMatch(/["']@cloudflare\/vite-plugin/);
    }
  });
});

describe("framework factory", () => {
  it("default-exports a factory producing a Layer<Framework>", () => {
    expect(Layer.isLayer(framework({}))).toBe(true);
    expect(Layer.isLayer(make())).toBe(true);
  });
});
