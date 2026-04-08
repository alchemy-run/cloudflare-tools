import cloudflare, {
  type CloudflarePluginOptions,
} from "@distilled.cloud/cloudflare-rolldown-plugin";
import type * as rolldown from "rolldown";
import type * as vite from "vite";

export async function buildPlugins(options: CloudflarePluginOptions): Promise<Array<vite.Plugin>> {
  const plugins = await resolvePlugins(
    cloudflare({
      compatibilityDate: options.compatibilityDate,
      compatibilityFlags: options.compatibilityFlags,
    }),
  );
  return plugins.map((plugin): vite.Plugin => {
    if ("name" in plugin && plugin.name.startsWith("rolldown-plugin-cloudflare:")) {
      return {
        enforce: "pre",
        applyToEnvironment(environment) {
          return environment.name !== "client";
        },
        ...plugin,
      } as vite.Plugin;
    }
    return plugin as vite.Plugin;
  });
}

async function resolvePlugins(
  pluginOption: rolldown.RolldownPluginOption,
): Promise<Array<rolldown.RolldownPlugin>> {
  const result: Array<rolldown.RolldownPlugin> = [];
  const plugins = await pluginOption;
  if (!plugins) {
    return result;
  }
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      result.push(...(await resolvePlugins(plugin)));
    }
  } else {
    result.push(plugins);
  }
  return result;
}
