import cloudflare, {
  type CloudflarePluginOptions,
} from "@distilled.cloud/cloudflare-rolldown-plugin";
import type { RolldownPluginOption } from "rolldown";
import type * as vite from "vite";

export async function buildPlugins(options: CloudflarePluginOptions): Promise<Array<vite.Plugin>> {
  const plugins = await resolvePlugins(
    cloudflare({
      compatibilityDate: options.compatibilityDate,
      compatibilityFlags: options.compatibilityFlags,
    }),
  );
  return plugins.map(
    (plugin): vite.Plugin => ({
      enforce: "pre",
      applyToEnvironment(environment) {
        return environment.name !== "client";
      },
      ...plugin,
    }),
  );
}

async function resolvePlugins(pluginOption: RolldownPluginOption): Promise<Array<vite.Plugin>> {
  const plugins: Array<vite.Plugin> = [];
  const awaited = await pluginOption;
  if (!awaited) {
    return plugins;
  }
  if (Array.isArray(awaited)) {
    for (const plugin of awaited) {
      plugins.push(...(await resolvePlugins(plugin)));
    }
  } else if ("name" in awaited) {
    plugins.push(awaited as vite.Plugin);
  }
  return plugins;
}
