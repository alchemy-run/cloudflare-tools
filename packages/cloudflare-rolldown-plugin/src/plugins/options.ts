import path from "node:path";
import type * as vite from "vite";
import { createPlugin } from "../factory.js";
import { parseViteEnvironments, type BasePluginOptions } from "../options.js";
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
        const environmentNames = parseViteEnvironments(pluginOptions);
        input = normalizeInput(
          pluginOptions.main ?? defaultEnvironmentEntries(environmentNames[0], userConfig) ?? {},
        );
        const rollupOptions: vite.Rollup.RollupOptions = {
          input: wrapInput(input),
          preserveEntrySignatures: "strict",
        };
        const define = getDefine(
          pluginOptions,
          process.env.NODE_ENV || userConfig.mode || "production",
        );
        const makeEnvironment = ({
          name,
          isEntry,
        }: {
          name: string;
          isEntry: boolean;
        }): vite.EnvironmentOptions => {
          const entries = isEntry
            ? (pluginOptions.main ?? defaultEnvironmentEntries(name, userConfig))
            : (defaultEnvironmentEntries(name, userConfig) ?? pluginOptions.main);
          return {
            // Bake `process.env.NODE_ENV` (and friends) into the worker build.
            // workerd has no value for it at runtime, so without this libraries
            // like React fall back to their development builds. Setting `define`
            // at the environment level applies it even though `keepProcessEnv`
            // stays `true` (so other `process.env` access is preserved at
            // runtime for `nodejs_compat`).
            define,
            resolve: {
              noExternal: true,
              conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
            },
            optimizeDeps: {
              noDiscovery: false,
              ignoreOutdatedRequests: true,
              entries: asArray(entries)?.map(vite.normalizePath),
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
            // The entry environment owns the Worker's build input and server
            // output directory; children (e.g. `ssr`) keep their own build config
            // from the framework plugin (`@vitejs/plugin-rsc`).
            ...(isEntry
              ? {
                  build: {
                    ssr: true,
                    target: TARGET,
                    emitAssets: true,
                    copyPublicDir: false,
                    outDir: getOutputDirectory(userConfig, name),
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
                }
              : {}),
          };
        };
        const appType = userConfig.appType ?? (Object.keys(input).length === 0 ? "spa" : "custom");
        return {
          appType,
          builder:
            appType === "spa"
              ? undefined
              : {
                  buildApp: async (builder) => {
                    for (const environment of Object.values(builder.environments)) {
                      await builder.build(environment);
                    }
                  },
                },
          ssr: {
            noExternal: true,
            resolve: {
              conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
            },
          },
          environments: {
            client: {
              build: {
                outDir: getOutputDirectory(userConfig, "client"),
              },
            },
            ...Object.fromEntries(
              environmentNames.map((name, index) => [
                name,
                makeEnvironment({ name, isEntry: index === 0 }),
              ]),
            ),
          },
        };
      },
    },
  };
});

const defaultEnvironmentEntries = (
  environmentName: string,
  userConfig: vite.UserConfig,
): vite.Rolldown.InputOption | undefined => {
  const environment = userConfig.environments?.[environmentName];
  return environment?.build?.rolldownOptions?.input ?? environment?.build?.rollupOptions?.input;
};

const asArray = (
  input: string | Array<string> | Record<string, string> | undefined,
): Array<string> | undefined => {
  if (!input) return;
  if (typeof input === "string") return [input];
  if (Array.isArray(input) && input.length > 0) return input;
  return Object.values(input);
};

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

const getDefine = (options: BasePluginOptions, nodeEnv: string): Record<string, string> => {
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
};

const getOutputDirectory = (userConfig: vite.UserConfig, environmentName: string) => {
  const rootOutputDirectory = userConfig.build?.outDir ?? "dist";

  return (
    userConfig.environments?.[environmentName]?.build?.outDir ??
    path.join(rootOutputDirectory, environmentName)
  );
};
