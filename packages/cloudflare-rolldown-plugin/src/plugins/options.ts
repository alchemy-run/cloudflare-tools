import type * as vite from "vite";
import { createPlugin } from "../factory.js";
import { hasNodejsCompat } from "../utils.js";
import { WORKER_ENTRY_PREFIX } from "./virtual-modules.js";

const DEFAULT_CONDITIONS = ["workerd", "worker", "module", "browser"];

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
      options.input = wrapEntryInput(options.input ?? {});
      options.preserveEntrySignatures ??= "strict";
      options.platform ??= "neutral";
      options.resolve ??= {};
      options.resolve.conditionNames ??= [...DEFAULT_CONDITIONS, "production"];
      options.resolve.extensions ??= DEFAULT_RESOLVE_EXTENSIONS;
      options.transform ??= {};
      options.transform.target ??= TARGET;
      options.transform.define ??= {};
      Object.assign(options.transform.define, {
        "process.env.NODE_ENV": '"production"',
        "global.process.env.NODE_ENV": '"production"',
        "globalThis.process.env.NODE_ENV": '"production"',
        ...(hasNodejsCompat(pluginOptions.compatibilityFlags)
          ? {}
          : {
              "process.env": "{}",
              "global.process.env": "{}",
              "globalThis.process.env": "{}",
            }),
        ...(pluginOptions.compatibilityDate && pluginOptions.compatibilityDate >= "2022-03-21"
          ? {
              "navigator.userAgent": '"Cloudflare-Workers"',
            }
          : {}),
      });
      return options;
    },
  },
  vite: {
    config(options) {
      const isRolldown = "rolldownVersion" in this.meta;
      const rollupOptions: vite.Rollup.RollupOptions = {
        input: wrapEntryInput(options.environments?.ssr?.build?.rollupOptions?.input ?? {}),
        preserveEntrySignatures: "strict",
      };
      return {
        ssr: {
          noExternal: true,
          resolve: {
            conditions: [...DEFAULT_CONDITIONS, "development|production"],
          },
        },
        environments: {
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
              ...(isRolldown
                ? {
                    // rolldownOptions: {
                    //   ...rollupOptions,
                    //   platform: "neutral",
                    //   resolve: {
                    //     extensions: DEFAULT_RESOLVE_EXTENSIONS,
                    //   },
                    // },
                  }
                : { rollupOptions }),
            },
            optimizeDeps: {
              noDiscovery: false,
              ignoreOutdatedRequests: true,
              ...(isRolldown
                ? {
                    rolldownOptions: {
                      platform: "neutral",
                      resolve: {
                        conditionNames: [...DEFAULT_CONDITIONS, "development|production"],
                        extensions: DEFAULT_RESOLVE_EXTENSIONS,
                      },
                      transform: {
                        target: TARGET,
                        define: {
                          "process.env.NODE_ENV": '"production"',
                          "global.process.env.NODE_ENV": '"production"',
                          "globalThis.process.env.NODE_ENV": '"production"',
                        },
                      },
                    },
                  }
                : {
                    // esbuildOptions: {
                    //   platform: "neutral",
                    //   conditions: [...DEFAULT_CONDITIONS, "development|production"],
                    //   resolveExtensions: DEFAULT_RESOLVE_EXTENSIONS,
                    //   target: TARGET,
                    //   define: {
                    //     "process.env.NODE_ENV": '"production"',
                    //     "global.process.env.NODE_ENV": '"production"',
                    //     "globalThis.process.env.NODE_ENV": '"production"',
                    //   },
                    // },
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
    return virtualEntryId(input);
  }
  if (Array.isArray(input)) {
    return input.map(virtualEntryId);
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [virtualEntryId(key), value]),
  );
}
