/**
 * Spike fork of `@astrojs/cloudflare` (v14.1.3, upstream/astro
 * packages/integrations/cloudflare/src/index.ts) with:
 *
 * - `@cloudflare/vite-plugin` swapped for `@distilled.cloud/cloudflare-vite-plugin`
 *   (main = '@astrojs/cloudflare/entrypoints/server', entry env 'ssr').
 * - `loadWranglerEnv`, wrangler config watchers, `previewEntrypoint`, the
 *   output-wrangler.json patch, and the workerd prerenderer all dropped.
 * - `prerenderEnvironment: 'node'` hardwired (astro's stock node prerenderer).
 * - Sessions disabled (no KV in our local runtime yet); image service is
 *   `passthrough`.
 * - The `virtual:astro-cloudflare:config` plugin copied verbatim (it is not
 *   exported by the published package).
 */
import type { CloudflareVitePluginOptions } from "@distilled.cloud/cloudflare-vite-plugin";
import cloudflareVitePlugin from "@distilled.cloud/cloudflare-vite-plugin";
import type { AstroIntegration } from "astro";
import { passthroughImageService } from "astro/config";
import type * as vite from "vite";

const VIRTUAL_CONFIG_ID = "virtual:astro-cloudflare:config";
const RESOLVED_VIRTUAL_CONFIG_ID = "\0" + VIRTUAL_CONFIG_ID;

/** Copy of upstream `vite-plugin-config.ts` (not exported from the package). */
function createConfigPlugin(config: {
  sessionKVBindingName: string;
  compileImageConfig: null;
  cacheProviderEnabled: boolean;
}): vite.Plugin {
  return {
    name: VIRTUAL_CONFIG_ID,
    resolveId: {
      filter: { id: new RegExp(`^${VIRTUAL_CONFIG_ID}$`) },
      handler() {
        return RESOLVED_VIRTUAL_CONFIG_ID;
      },
    },
    load: {
      filter: { id: new RegExp(`^${RESOLVED_VIRTUAL_CONFIG_ID.replace("\0", "\\0")}$`) },
      handler() {
        return [
          ...Object.entries(config).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`),
          `export const isPrerender = ${this.environment?.name === "prerender"};`,
        ].join("\n");
      },
    },
  };
}

/** Copy of upstream `vite-plugin-dev-server-prerender-middleware.ts`. */
function createNodePrerenderPlugin(): vite.Plugin {
  const devPrerenderMiddlewareSymbol = Symbol.for("astro.devPrerenderMiddleware");
  return {
    name: "@astrojs/cloudflare:dev-server-prerender-middleware",
    config() {
      return { environments: { prerender: { dev: {} } } };
    },
    configureServer(server) {
      (server as any)[devPrerenderMiddlewareSymbol] = true;
    },
  };
}

export interface DistilledCloudflareOptions {
  /** Options forwarded to @distilled.cloud/cloudflare-vite-plugin. */
  vite: CloudflareVitePluginOptions;
}

export function distilledCloudflare(options: DistilledCloudflareOptions): AstroIntegration {
  return {
    name: "distilled-cloudflare",
    hooks: {
      "astro:config:setup": async ({ command, config, updateConfig }) => {
        const isTypeGenPhase = command === "build" || command === "sync";
        const userOptimizeDeps = config.vite?.optimizeDeps;

        const cloudflareVitePlugins = (
          cloudflareVitePlugin({
            main: "@astrojs/cloudflare/entrypoints/server",
            viteEnvironments: { entry: "ssr" },
            ...options.vite,
          }) as Array<vite.Plugin | null | undefined | false>
        ).filter((plugin): plugin is vite.Plugin => !!plugin);
        // Same trick as upstream: `build`/`sync` run type generation, which
        // creates a temporary Vite server and fires `configureServer` — that
        // would boot workerd during a build. Strip it.
        if (isTypeGenPhase) {
          for (const plugin of cloudflareVitePlugins) {
            plugin.configureServer = undefined;
          }
        }
        // SPIKE WORKAROUND: our plugin family is not environment-scoped, but
        // astro introduces two NODE-side server environments (`prerender`,
        // `astro`) into the same dev server / builder. Keep our per-environment
        // hooks (resolveId/load/transform/configEnvironment) away from them so
        // unenv polyfills and worker resolve conditions don't leak into node.
        // The real package should make cloudflare-vite-plugin accept
        // `skipEnvironments` (or scope with applyToEnvironment itself).
        const NODE_ENVIRONMENTS = ["prerender", "astro"];
        for (const plugin of cloudflareVitePlugins) {
          const original = plugin.applyToEnvironment;
          plugin.applyToEnvironment = (environment) =>
            !NODE_ENVIRONMENTS.includes(environment.name) &&
            (original ? (original as any).call(plugin, environment) : true);
        }
        // SPIKE WORKAROUND: nodejs-compat's `configureServer` is a server-level
        // hook (applyToEnvironment cannot gate it) and it calls
        // `registerMissingImport` on every environment's depsOptimizer; the
        // node-side `prerender`/`astro` environments use vite's no-discovery
        // optimizer whose registerMissingImport throws. Swallow that.
        // SPIKE WORKAROUND: our optionsPlugin unconditionally returns a
        // `builder.buildApp` from its config hook; vite merges plugin config
        // results OVER the user config (`mergeConfig(conf, res)`), which
        // clobbers astro's own buildApp orchestrator (prerender -> ssr ->
        // client with input discovery + chunk extraction). Capture astro's
        // buildApp before our plugin runs and restore it afterwards. The real
        // package fix: optionsPlugin must only default buildApp when the user
        // config doesn't define one.
        let astroBuildApp: ((builder: vite.ViteBuilder) => Promise<void>) | undefined;
        const captureBuildApp: vite.Plugin = {
          name: "spike:capture-buildapp",
          enforce: "pre",
          config(config) {
            astroBuildApp = config.builder?.buildApp;
          },
        };
        const restoreBuildApp: vite.Plugin = {
          name: "spike:restore-buildapp",
          enforce: "post",
          config() {
            if (astroBuildApp) {
              return { builder: { buildApp: astroBuildApp } };
            }
          },
        };
        const depsOptimizerGuard: vite.Plugin = {
          name: "spike:node-env-deps-optimizer-guard",
          // must run before nodejs-compat's configureServer, which is enforce:pre
          enforce: "pre",
          configureServer(server) {
            for (const name of NODE_ENVIRONMENTS) {
              const optimizer = server.environments[name]?.depsOptimizer;
              if (!optimizer) continue;
              const original = optimizer.registerMissingImport.bind(optimizer);
              optimizer.registerMissingImport = ((id: string, resolved: string) => {
                try {
                  return original(id, resolved);
                } catch {
                  return undefined as never;
                }
              }) as typeof optimizer.registerMissingImport;
            }
          },
        };

        updateConfig({
          build: { redirects: false },
          vite: {
            plugins: [
              ...(command === "dev" ? [createNodePrerenderPlugin()] : []),
              captureBuildApp,
              restoreBuildApp,
              depsOptimizerGuard,
              cloudflareVitePlugins,
              {
                name: "@astrojs/cloudflare:cf-imports",
                enforce: "pre",
                resolveId: {
                  filter: { id: /^cloudflare:/ },
                  handler(id) {
                    return { id, external: true };
                  },
                },
              },
              {
                name: "@astrojs/cloudflare:environment",
                configEnvironment(environmentName, _options) {
                  if (isTypeGenPhase) {
                    return { optimizeDeps: { noDiscovery: true, include: [] } };
                  }
                  const isServerEnvironment = ["astro", "ssr", "prerender"].includes(
                    environmentName,
                  );
                  if (isServerEnvironment && !_options.optimizeDeps?.noDiscovery) {
                    return {
                      optimizeDeps: {
                        include: [
                          "@astrojs/cloudflare/entrypoints/server",
                          "astro",
                          "astro/runtime/**",
                          "astro > html-escaper",
                          "astro > mrmime",
                          "astro > zod/v4",
                          "astro > zod/v4/core",
                          "astro > clsx",
                          "astro > cookie",
                          "astro > devalue",
                          "astro > @oslojs/encoding",
                          "astro > es-module-lexer",
                          "astro > unstorage",
                          "astro > neotraverse/modern",
                          "astro > piccolore",
                          "astro > picomatch",
                          "astro/app",
                          "astro/app/fetch/default-handler",
                          "astro/fetch",
                          "astro/assets",
                          "astro/assets/runtime",
                          "astro/assets/utils/inferRemoteSize.js",
                          "astro/assets/fonts/runtime.js",
                          "astro/compiler-runtime",
                          "astro/jsx-runtime",
                          "astro/app/entrypoint/dev",
                          "astro/virtual-modules/middleware.js",
                          "astro/virtual-modules/transitions.js",
                          "astro/virtual-modules/transitions-events.js",
                          "astro/virtual-modules/transitions-router.js",
                          "astro/virtual-modules/transitions-swap-functions.js",
                          "astro/virtual-modules/transitions-types.js",
                          "astro/components",
                          ...(Array.isArray(userOptimizeDeps?.include)
                            ? userOptimizeDeps.include
                            : []),
                        ],
                        exclude: [
                          "unstorage/drivers/cloudflare-kv-binding",
                          "astro:*",
                          "virtual:astro:*",
                          "virtual:astro-cloudflare:*",
                          "virtual:@astrojs/*",
                          "@astrojs/starlight",
                          ...(Array.isArray(userOptimizeDeps?.exclude)
                            ? userOptimizeDeps.exclude
                            : []),
                        ],
                      },
                    };
                  } else if (environmentName === "client") {
                    return {
                      optimizeDeps: {
                        include: ["astro/runtime/client/dev-toolbar/entrypoint.js"],
                        ignoreOutdatedRequests: true,
                      },
                    };
                  }
                },
              } satisfies vite.Plugin,
              {
                enforce: "post",
                name: "@astrojs/cloudflare:cf-externals",
                applyToEnvironment: (environment) =>
                  environment.name === "ssr" || environment.name === "prerender",
                config(conf) {
                  if (conf.ssr) {
                    // Cloudflare does not support externalizing modules in server environments
                    conf.ssr.external = undefined;
                  }
                },
              } satisfies vite.Plugin,
              createConfigPlugin({
                sessionKVBindingName: "SESSION",
                compileImageConfig: null,
                cacheProviderEnabled: false,
              }),
            ],
          },
          image: {
            ...config.image,
            service: passthroughImageService(),
            endpoint: (command === "dev"
              ? { entrypoint: "astro/assets/endpoint/generic" }
              : { entrypoint: "@astrojs/cloudflare/image-passthrough-endpoint" }) as never,
          },
        });
      },
      "astro:config:done": ({ setAdapter, buildOutput }) => {
        setAdapter({
          name: "distilled-cloudflare",
          adapterFeatures: {
            buildOutput,
            middlewareMode: "classic",
            preserveBuildClientDir: true,
            preserveBuildServerDir: true,
          },
          entrypointResolution: "auto",
          supportedAstroFeatures: {
            serverOutput: "stable",
            hybridOutput: "stable",
            staticOutput: "stable",
            i18nDomains: "experimental",
            sharpImageService: { support: "limited", message: "workerd cannot run sharp" },
            envGetSecret: "stable",
          },
        });
      },
      "astro:build:setup": ({ vite: viteConfig, target }) => {
        if (target === "server") {
          viteConfig.resolve ||= {};
          viteConfig.resolve.alias ||= {};
          viteConfig.ssr ||= {};
          viteConfig.ssr.noExternal = true;

          viteConfig.build ||= {};
          (viteConfig.build as any).rolldownOptions ||= {};
          (viteConfig.build as any).rolldownOptions.output ||= {};
          (viteConfig.build as any).rolldownOptions.external = ["sharp"];
          (viteConfig.build as any).rolldownOptions.output.banner ||=
            "globalThis.process ??= {}; globalThis.process.env ??= {};";

          viteConfig.define = {
            "process.env": "process.env",
            "globalThis.__ASTRO_IMAGES_BINDING_NAME": JSON.stringify("IMAGES"),
            ...viteConfig.define,
          };
        }
      },
    },
  };
}
