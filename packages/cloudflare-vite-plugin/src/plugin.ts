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

// This will contain:
// - runtime options for development mode, e.g. assets, bindings, durable objects, workflows
// - bundler options for builds, e.g. additional modules
// - options that apply to both, e.g. main/entry point, compatibility date, compatibility flags
export interface PluginOptions {
  main?: string;
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
  assets?: unknown;
  bindings?: Array<unknown>;
  durableObjects?: Array<unknown>;
  workflows?: Array<unknown>;
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

export default async function cloudflareVitePlugin(
  options: PluginOptions = {},
): Promise<Array<vite.Plugin>> {
  const plugins = await resolvePlugins(
    cloudflare({
      compatibilityDate: options.compatibilityDate,
      compatibilityFlags: options.compatibilityFlags,
    }),
  );
  return plugins.map((plugin) => ({
    enforce: "pre",
    applyToEnvironment(environment) {
      return environment.name !== "client";
    },
    ...plugin,
  }));
}
