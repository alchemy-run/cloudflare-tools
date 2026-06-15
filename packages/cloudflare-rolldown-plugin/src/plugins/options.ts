import path from "node:path";
import type * as vite from "vite";
import { createPlugin } from "../factory.js";
import { type CloudflarePluginOptions, workerEnvironments } from "../options.js";
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
        const { entry: entryEnv, children: childEnvs } = workerEnvironments(pluginOptions);
        input = normalizeInput(
          pluginOptions.main ??
            userConfig.environments?.[entryEnv]?.build?.rolldownOptions?.input ??
            userConfig.environments?.[entryEnv]?.build?.rollupOptions?.input ??
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

        // The dep-prebundle scanner for each Worker environment must be rooted
        // at THAT environment's own entry, so its whole module graph (e.g. an
        // RSC app's `ssr` env pulling react-dom/server + react) is bundled in
        // the initial optimize pass. Sharing one `entries` (or one config
        // object) across envs leaves children with no scan root, so their deps
        // are discovered lazily and re-optimized mid-session — which re-hashes
        // and duplicates singletons like React (a null hooks dispatcher).
        const resolveEnvironmentEntries = (name: string): Array<string> | undefined => {
          // Single-worker (non-RSC) default: preserve the original behavior
          // exactly — the optimizer's scan root comes only from an explicit
          // `main`, otherwise it's left to Vite's auto-discovery. The per-env
          // input fallback below applies only to multi-environment topologies.
          if (childEnvs.length === 0) {
            return pluginOptions.main ? [vite.normalizePath(pluginOptions.main)] : undefined;
          }
          const rawInput =
            name === entryEnv
              ? (pluginOptions.main ??
                userConfig.environments?.[name]?.build?.rolldownOptions?.input ??
                userConfig.environments?.[name]?.build?.rollupOptions?.input)
              : (userConfig.environments?.[name]?.build?.rolldownOptions?.input ??
                userConfig.environments?.[name]?.build?.rollupOptions?.input ??
                pluginOptions.main);
          if (!rawInput) return undefined;
          const values =
            typeof rawInput === "string"
              ? [rawInput]
              : Array.isArray(rawInput)
                ? rawInput
                : Object.values(rawInput);
          return values.length > 0 ? values.map((value) => vite.normalizePath(value)) : undefined;
        };

        // The Worker treatment (workerd resolve conditions + dependency
        // pre-bundling) applies to the entry environment AND every child
        // environment it loads at runtime — without `noDiscovery: false` the
        // child/entry envs get Vite's throwing deps optimizer, which breaks
        // RSC dev (`registerMissingImport is not supported in dev <env>`). A
        // fresh config object is built per environment so each can carry its
        // own `optimizeDeps.entries` without aliasing the others.
        const makeWorkerEnvironment = (
          name: string,
          { isEntry }: { isEntry: boolean },
        ): vite.EnvironmentOptions => ({
          resolve: {
            noExternal: true,
            conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
          },
          optimizeDeps: {
            noDiscovery: false,
            ignoreOutdatedRequests: true,
            entries: resolveEnvironmentEntries(name),
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
              }
            : {}),
        });

        return {
          appType,
          // Legacy top-level `ssr` namespace: a baseline for any SSR-kind env
          // that doesn't override. Each Worker env sets its own `resolve`
          // below; this stays as a harmless default.
          ssr: {
            noExternal: true,
            resolve: {
              conditions: [...DEFAULT_RESOLVE_CONDITION_NAMES, "development|production"],
            },
          },
          builder:
            // Multi-environment (RSC) topologies are orchestrated by the
            // framework plugin's own multi-pass `buildApp` (e.g.
            // `@vitejs/plugin-rsc`). Defer to it; setting our own here rebuilds
            // every environment on top of the framework's passes. The
            // single-worker path keeps the explicit per-environment builder.
            appType === "spa" || childEnvs.length > 0
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
            [entryEnv]: makeWorkerEnvironment(entryEnv, { isEntry: true }),
            ...Object.fromEntries(
              childEnvs.map((name) => [name, makeWorkerEnvironment(name, { isEntry: false })]),
            ),
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
