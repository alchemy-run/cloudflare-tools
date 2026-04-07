// The plugin will:
// 1. Use build plugins from @distilled.cloud/cloudflare-bundler (these will need to be adapted)
// 2. Integrate @distilled.cloud/cloudflare-local for development mode, which will require more plugins
//
// There will be a standardized build output format including:
// - the client bundle (which will be uploaded as assets)
// - the worker bundle itself (unless it's an SPA)
// - probably a manifest file, so Alchemy can read everything and know how to deploy it (serves a similar role to .wrangler/deploy/config.json)
//
// Note on plugins:
// - The Vite plugin API is an extension of the Rollup plugin API. Technically in Vite 8, it's extending the Rolldown plugin option type, but Rolldown implements the same interface as Rollup. The @distilled.cloud/cloudflare-bundler package uses unplugin (which also extends the Rollup plugin API) as the baseline, so this shouldn't matter.

import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import type { RolldownPluginOption } from "rolldown";
import type * as vite from "vite";

const CLOUDFLARE_BUILT_IN_MODULES = [
  "cloudflare:email",
  "cloudflare:node",
  "cloudflare:sockets",
  "cloudflare:workers",
  "cloudflare:workflows",
];

const DEFAULT_CONDITIONS = ["workerd", "worker", "module", "browser"];

const TARGET = "es2024";

const VIRTUAL_WORKER_ENTRY = "virtual:distilled/worker-entry";
const VIRTUAL_USER_ENTRY = "virtual:distilled/user-entry";

// This will contain:
// - runtime options for development mode, e.g. assets, bindings, durable objects, workflows
// - bundler options for builds, e.g. additional modules
// - options that apply to both, e.g. main/entry point, compatibility date, compatibility flags
export interface PluginOptions {
  main?: string;
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  // assets?: unknown;
  // bindings?: Array<unknown>;
  // durableObjects?: Array<unknown>;
  // workflows?: Array<unknown>;
}

async function resolvePlugins(pluginOption: RolldownPluginOption): Promise<Array<vite.Plugin>> {
  const plugins: Array<vite.Plugin> = [];
  if (Array.isArray(pluginOption)) {
    for (const plugin of pluginOption) {
      plugins.push(...(await resolvePlugins(plugin)));
    }
  } else if (pluginOption) {
    // @ts-expect-error - this doesn't work
    plugins.push(await pluginOption);
  }
  return plugins;
}

function getEntryInput(input: vite.Rollup.InputOption | undefined): string | undefined {
  if (typeof input === "string") {
    return input;
  }

  if (Array.isArray(input)) {
    return input.length === 1 ? input[0] : undefined;
  }

  if (!input) {
    return undefined;
  }

  const values = Object.values(input);
  return values.length === 1 ? values[0] : undefined;
}

function wrapEntryInput(
  input: vite.Rollup.InputOption | undefined,
): vite.Rollup.InputOption | undefined {
  if (typeof input === "string") {
    return { server: VIRTUAL_WORKER_ENTRY };
  }

  if (Array.isArray(input)) {
    return input.length === 1 ? { server: VIRTUAL_WORKER_ENTRY } : input;
  }

  if (!input) {
    return input;
  }

  const entries = Object.entries(input);
  if (entries.length !== 1) {
    return input;
  }

  const [entryName] = entries[0];
  return { [entryName]: VIRTUAL_WORKER_ENTRY };
}

export default async function cloudflareVitePlugin(
  options: PluginOptions = {},
): Promise<Array<vite.Plugin>> {
  const environmentEntries = new Map<string, string>();
  const plugins = await resolvePlugins(
    cloudflare({
      compatibilityDate: options.compatibilityDate,
      compatibilityFlags: options.compatibilityFlags,
    }),
  );
  return [
    {
      name: "distilled:vite",
      config() {
        return {
          // Framework-owned SSR environments still read the top-level `ssr` config,
          // so keep the bundling escape hatch here even before we add full custom
          // Worker environments.
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
                builtins: [...CLOUDFLARE_BUILT_IN_MODULES],
              },
              build: {
                ssr: true,
                target: TARGET,
                emitAssets: true,
                copyPublicDir: false,
                rolldownOptions: {
                  preserveEntrySignatures: "strict",
                },
              },
              optimizeDeps: {
                noDiscovery: false,
                ignoreOutdatedRequests: true,
                ...(options.main ? { entries: options.main } : {}),
                exclude: [...CLOUDFLARE_BUILT_IN_MODULES],
              },
              keepProcessEnv: true,
            },
          },
        } satisfies vite.UserConfig;
      },
      applyToEnvironment(environment) {
        return environment.name !== "client";
      },
      resolveId(source) {
        if (source === VIRTUAL_WORKER_ENTRY || source === VIRTUAL_USER_ENTRY) {
          return `\0${source}`;
        }
      },
      async load(id) {
        if (id === `\0${VIRTUAL_USER_ENTRY}`) {
          const input = environmentEntries.get(this.environment.name);
          if (!input) {
            throw new Error(`Missing worker entry for environment "${this.environment.name}"`);
          }

          const resolved = await this.resolve(input);
          if (!resolved) {
            throw new Error(`Failed to resolve worker entry "${input}"`);
          }

          return `
import mod from ${JSON.stringify(resolved.id)};

export default mod;
          `;
        }

        if (id === `\0${VIRTUAL_WORKER_ENTRY}`) {
          return `
import * as mod from ${JSON.stringify(VIRTUAL_USER_ENTRY)};

export default mod.default ?? {};
          `;
        }
      },
      options(rollupOptions) {
        const input = getEntryInput(rollupOptions.input);
        if (!input) {
          return rollupOptions;
        }

        environmentEntries.set(this.environment.name, input);
        rollupOptions.input = wrapEntryInput(rollupOptions.input);
        return rollupOptions;
      },
    },
    ...plugins.map(
      (plugin): vite.Plugin => ({
        enforce: "pre",
        applyToEnvironment(environment) {
          return environment.name !== "client";
        },
        ...plugin,
      }),
    ),
  ];
}
