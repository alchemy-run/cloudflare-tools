import type * as vite from "vite";
import { buildPlugins } from "./build-plugins.js";

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

export interface PluginOptions {
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
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
                rollupOptions: { preserveEntrySignatures: "strict" },
                // @ts-expect-error rolldown-vite reads this key instead of rollupOptions
                rolldownOptions: { preserveEntrySignatures: "strict" },
              },
              optimizeDeps: {
                noDiscovery: false,
                ignoreOutdatedRequests: true,
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
    ...(await buildPlugins(options)),
  ];
}
