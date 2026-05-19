import path from "node:path";
import type * as vite from "vite";
import { createPlugin } from "../factory.js";
import type { CloudflarePluginOptions } from "../options.js";
import { hasNodejsCompat } from "../utils.js";
import { WORKER_ENTRY_PREFIX } from "./virtual-modules.js";

const DEFAULT_RESOLVE_CONDITION_NAMES = ["workerd", "worker", "module", "browser"];
const DEFAULT_RESOLVE_MAIN_FIELDS = ["browser", "module", "jsnext:main", "jsnext", "main"];
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

export interface OptionsApi {
  input: () => Record<string, string>;
}

export const optionsPlugin = createPlugin<"options", OptionsApi>("options", (pluginOptions) => {
  let input: Record<string, string> = {};
  return {
    shared: {
      api: {
        input: () => input,
      },
    },
    rolldown: {
      options(options) {
        input = normalizeInput(pluginOptions.main ?? options.input ?? {});
        options.input = wrapInput(input);
        options.preserveEntrySignatures ??= "strict";
        options.platform ??= "neutral";
        options.resolve ??= {};
        options.resolve.conditionNames ??= [...DEFAULT_RESOLVE_CONDITION_NAMES, "production"];
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
        input = normalizeInput(
          pluginOptions.main ??
            userConfig.environments?.ssr?.build?.rolldownOptions?.input ??
            userConfig.environments?.ssr?.build?.rollupOptions?.input ??
            {},
        );
        const rollupOptions: vite.Rollup.RollupOptions = {
          input: wrapInput(input),
          preserveEntrySignatures: "strict",
        };
        const define = getDefine(
          pluginOptions,
          process.env.NODE_ENV || userConfig.mode || "production",
        );
        const appType = userConfig.appType ?? (Object.keys(input).length === 0 ? "spa" : "custom");
        return {
          appType,
          ssr: {
            noExternal: true,
            resolve: {
              conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
            },
          },
          builder:
            appType === "spa"
              ? undefined
              : {
                  buildApp: async (app) => {
                    for (const environment of Object.values(app.environments)) {
                      await app.build(environment);
                    }
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
                conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
              },
              build: {
                ssr: true,
                target: TARGET,
                emitAssets: true,
                copyPublicDir: false,
                outDir: getOutputDirectory(userConfig, "server"),
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
                ...(isRolldown
                  ? {
                      rolldownOptions: {
                        platform: "neutral",
                        resolve: {
                          conditionNames: [
                            ...DEFAULT_RESOLVE_CONDITION_NAMES,
                            "development|production",
                          ],
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
                        conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
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
  };
});

const normalizeInput = (
  input: string | Array<string> | Record<string, string>,
): Record<string, string> => {
  if (typeof input === "string") {
    return { [path.parse(input).name || "index"]: input };
  } else if (Array.isArray(input)) {
    return Object.fromEntries(input.map((p) => [path.parse(p).name, p]));
  } else {
    return input;
  }
};

const wrapInput = (input: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(input).map(([key, id]) => [key, `${WORKER_ENTRY_PREFIX}${id}` as const]),
  );

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
