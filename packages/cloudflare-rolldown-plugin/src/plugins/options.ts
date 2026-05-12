import { nonPrefixedNodeModules } from "@cloudflare/unenv-preset";
import path from "node:path";
import type * as vite from "vite";
import { createPlugin } from "../factory.js";
import type { CloudflarePluginOptions } from "../options.js";
import { hasNodejsCompat } from "../utils.js";
import { WORKER_ENTRY_PREFIX } from "./virtual-modules.js";

const DEFAULT_CONDITIONS = ["workerd", "worker", "module", "browser"];

const DEFAULT_RESOLVE_MAIN_FIELDS = ["browser", "module", "jsnext:main", "jsnext"];

const DEFAULT_RESOLVE_EXTENSIONS = [
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".cjs",
  ".cts",
  ".ctx",
];

const TARGET = "es2024";

export const optionsPlugin = createPlugin("options", (pluginOptions) => ({
  rolldown: {
    options(options) {
      options.input = wrapEntryInput(pluginOptions.main ?? options.input ?? {});
      options.preserveEntrySignatures ??= "strict";
      options.platform ??= "neutral";
      options.resolve ??= {};
      options.resolve.conditionNames ??= [...DEFAULT_CONDITIONS, "production"];
      options.resolve.mainFields ??= DEFAULT_RESOLVE_MAIN_FIELDS;
      options.resolve.extensions ??= DEFAULT_RESOLVE_EXTENSIONS;
      options.transform ??= {};
      options.transform.target ??= TARGET;
      options.transform.define ??= {};
      Object.assign(options.transform.define, getDefine(pluginOptions, "production"));
      return options;
    },
  },
  vite: {
    async config(userConfig) {
      const vite = await import("vite");
      const isRolldown = "rolldownVersion" in this.meta;
      const input =
        pluginOptions.main ??
        userConfig.environments?.ssr?.build?.rolldownOptions?.input ??
        userConfig.environments?.ssr?.build?.rollupOptions?.input;
      const rollupOptions: vite.Rollup.RollupOptions = {
        input: wrapEntryInput(input ?? {}),
        preserveEntrySignatures: "strict",
      };
      const define = getDefine(
        pluginOptions,
        process.env.NODE_ENV || userConfig.mode || "production",
      );
      // oxlint-disable no-console
      console.log("Config:", {
        input,
        rollupOptions,
        define,
      });
      return {
        appType: "custom",
        ssr: {
          noExternal: true,
          resolve: {
            conditions: [...DEFAULT_CONDITIONS, "development|production"],
          },
        },
        builder: {
          buildApp: async (app) => {
            console.log(app.environments);
            await app.build(app.environments.ssr);
            await app.build(app.environments.client);
          },
        },
        environments: {
          client: {
            build: {
              outDir: getOutputDirectory(userConfig, "client"),
            },
          },
          ssr: {
            resolve: {
              noExternal: true,
              conditions: [...DEFAULT_CONDITIONS, "development|production"],
            },
            build: {
              ssr: true,
              target: TARGET,
              emitAssets: true,
              copyPublicDir: false,
              outDir: getOutputDirectory(userConfig, "ssr"),
              ...(isRolldown
                ? {
                    rolldownOptions: {
                      ...rollupOptions,
                      platform: "neutral",
                      resolve: {
                        mainFields: DEFAULT_RESOLVE_MAIN_FIELDS,
                        extensions: DEFAULT_RESOLVE_EXTENSIONS,
                      },
                    },
                  }
                : { rollupOptions }),
            },
            optimizeDeps: {
              noDiscovery: false,
              ignoreOutdatedRequests: true,
              entries: pluginOptions.main ? vite.normalizePath(pluginOptions.main) : undefined,
              exclude: [
                ...nonPrefixedNodeModules,
                ...nonPrefixedNodeModules.map((module) => `node:${module}`),
                // New Node.js built-in modules are only published with the `node:` prefix.
                ...["node:sea", "node:sqlite", "node:test", "node:test/reporters"],
              ],
              ...(isRolldown
                ? {
                    rolldownOptions: {
                      platform: "neutral",
                      resolve: {
                        conditionNames: [...DEFAULT_CONDITIONS, "development|production"],
                        mainFields: DEFAULT_RESOLVE_MAIN_FIELDS,
                        extensions: DEFAULT_RESOLVE_EXTENSIONS,
                      },
                      transform: {
                        target: TARGET,
                        define,
                      },
                    },
                  }
                : {
                    esbuildOptions: {
                      platform: "neutral",
                      conditions: [...DEFAULT_CONDITIONS, "development|production"],
                      resolveExtensions: DEFAULT_RESOLVE_EXTENSIONS,
                      mainFields: DEFAULT_RESOLVE_MAIN_FIELDS,
                      target: TARGET,
                      define,
                    },
                  }),
            },
            keepProcessEnv: true,
          },
        },
      };
    },
  },
}));

function wrapEntryInput(input: string | Array<string> | Record<string, string>) {
  const virtualEntryId = (id: string) => `${WORKER_ENTRY_PREFIX}${id}` as const;
  if (typeof input === "string") {
    return { main: virtualEntryId(input) };
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map((key) => [key, virtualEntryId(key)]));
  }
  // oxlint-disable no-console
  console.log("wrapEntryInput", {
    input,
  });
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, virtualEntryId(value)]),
  );
}

function getDefine(options: CloudflarePluginOptions, nodeEnv: string): Record<string, string> {
  return {
    "process.env.NODE_ENV": JSON.stringify(nodeEnv),
    "global.process.env.NODE_ENV": JSON.stringify(nodeEnv),
    "globalThis.process.env.NODE_ENV": JSON.stringify(nodeEnv),
    ...(hasNodejsCompat(options.compatibilityFlags)
      ? {}
      : {
          "process.env": "{}",
          "global.process.env": "{}",
          "globalThis.process.env": "{}",
        }),
    ...(options.compatibilityDate && options.compatibilityDate >= "2022-03-21"
      ? {
          "navigator.userAgent": '"Cloudflare-Workers"',
        }
      : {}),
    ...(nodeEnv === "production"
      ? {
          "import.meta.hot": "false",
        }
      : {}),
  };
}

function getOutputDirectory(userConfig: vite.UserConfig, environmentName: string) {
  const rootOutputDirectory = userConfig.build?.outDir ?? "dist";

  return (
    userConfig.environments?.[environmentName]?.build?.outDir ??
    path.join(rootOutputDirectory, environmentName)
  );
}
