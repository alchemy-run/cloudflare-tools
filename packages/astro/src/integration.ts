/**
 * Wrangler-free fork of `@astrojs/cloudflare`'s `createIntegration`
 * (v14.1.3, `src/index.ts`) with:
 *
 * - `@cloudflare/vite-plugin` swapped for `@distilled.cloud/cloudflare-vite-plugin`
 *   (main = this package's vendored server entrypoint, entry env `ssr`,
 *   Astro's node-side `astro`/`prerender` environments in `skipEnvironments`).
 * - `loadWranglerEnv`, wrangler config watchers, `previewEntrypoint`, the
 *   output-wrangler.json patch, and the workerd prerenderer all dropped.
 * - `prerenderEnvironment: 'node'` hardwired (Astro's stock node prerenderer).
 * - Sessions left unconfigured (no local KV in our runtime yet); the image
 *   service is `passthrough` (workerd cannot run sharp, and the IMAGES
 *   binding is remote-only in our runtime).
 */
import type { CloudflareVitePluginOptions } from "@distilled.cloud/cloudflare-vite-plugin";
import cloudflareVitePlugin from "@distilled.cloud/cloudflare-vite-plugin";
import type { AstroIntegration } from "astro";
import { passthroughImageService } from "astro/config";
import type * as vite from "vite";
import { createConfigPlugin } from "./config-plugin.ts";
import { NODE_ENVIRONMENTS } from "./environments.ts";
import { createNodePrerenderPlugin } from "./prerender-middleware.ts";

/** The Worker entry module (the vendored `@astrojs/cloudflare` server entrypoint). */
export const SERVER_ENTRYPOINT = "@distilled.cloud/astro/entrypoints/server";

/** The production endpoint of the passthrough image service. */
export const IMAGE_PASSTHROUGH_ENDPOINT = "@distilled.cloud/astro/image-passthrough-endpoint";

export interface DistilledCloudflareOptions {
  /**
   * Options forwarded to `@distilled.cloud/cloudflare-vite-plugin`
   * (compatibility date/flags, worker name/bindings/assets, runtime context).
   * `main`, `viteEnvironments`, and the Astro node environments in
   * `skipEnvironments` are managed by the integration.
   */
  readonly vite?: CloudflareVitePluginOptions | undefined;
  /**
   * The name of the KV binding injected into Astro's session config when
   * present on the Worker env.
   * @default "SESSION"
   */
  readonly sessionKVBindingName?: string | undefined;
}

/**
 * The `@distilled.cloud/cloudflare-vite-plugin` options for an Astro project:
 * user options with `main` pinned to the vendored server entrypoint, the
 * worker pinned to Astro's `ssr` environment, and Astro's node-side
 * environments merged into `skipEnvironments` (exported for testing).
 */
export const makeIntegrationPluginOptions = (
  viteOptions: CloudflareVitePluginOptions = {},
): CloudflareVitePluginOptions => ({
  ...viteOptions,
  main: SERVER_ENTRYPOINT,
  viteEnvironments: { entry: "ssr" },
  skipEnvironments: [...new Set([...NODE_ENVIRONMENTS, ...(viteOptions.skipEnvironments ?? [])])],
});

export function distilledCloudflare(options: DistilledCloudflareOptions = {}): AstroIntegration {
  const sessionKVBindingName = options.sessionKVBindingName ?? "SESSION";
  return {
    name: "@distilled.cloud/astro",
    hooks: {
      "astro:config:setup": ({ command, config, updateConfig }) => {
        const isTypeGenPhase = command === "build" || command === "sync";
        const userOptimizeDeps = config.vite?.optimizeDeps;

        const cloudflarePlugins = cloudflareVitePlugin(
          makeIntegrationPluginOptions(options.vite),
        ) as Array<vite.Plugin>;

        // Same trick as upstream (astro#16332): `build`/`sync` run type
        // generation, which creates a temporary Vite server and fires
        // `configureServer` — that would boot workerd mid-build. Stripping
        // the hook degrades our dev environments to runnable stubs, a
        // supported contract of the dev plugin.
        if (isTypeGenPhase) {
          for (const plugin of cloudflarePlugins) {
            plugin.configureServer = undefined;
          }
        }

        updateConfig({
          build: { redirects: false },
          vite: {
            plugins: [
              ...(command === "dev" ? [createNodePrerenderPlugin()] : []),
              cloudflarePlugins,
              {
                name: "@distilled.cloud/astro:cf-imports",
                enforce: "pre",
                resolveId: {
                  filter: { id: /^cloudflare:/ },
                  handler(id) {
                    return { id, external: true };
                  },
                },
              } satisfies vite.Plugin,
              {
                name: "@distilled.cloud/astro:environment",
                configEnvironment(environmentName, environmentOptions) {
                  if (isTypeGenPhase) {
                    return { optimizeDeps: { noDiscovery: true, include: [] } };
                  }
                  const isServerEnvironment = ["astro", "ssr", "prerender"].includes(
                    environmentName,
                  );
                  if (isServerEnvironment && !environmentOptions.optimizeDeps?.noDiscovery) {
                    return {
                      optimizeDeps: {
                        include: [
                          SERVER_ENTRYPOINT,
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
                  return undefined;
                },
              } satisfies vite.Plugin,
              {
                enforce: "post",
                name: "@distilled.cloud/astro:cf-externals",
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
                sessionKVBindingName,
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
              : { entrypoint: IMAGE_PASSTHROUGH_ENDPOINT }) as never,
          },
        });
      },
      "astro:config:done": ({ setAdapter, buildOutput }) => {
        setAdapter({
          name: "@distilled.cloud/astro",
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
          const build = viteConfig.build as Record<string, any>;
          build.rolldownOptions ||= {};
          build.rolldownOptions.output ||= {};
          build.rolldownOptions.external = ["sharp"];
          build.rolldownOptions.output.banner ||=
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
