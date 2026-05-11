import type { CloudflarePluginOptions } from "@distilled.cloud/cloudflare-rolldown-plugin/options";
import {
  additionalModulesPlugin,
  cloudflareExternalsPlugin,
  nodejsAlsPlugin,
  nodejsImportWarningPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
  wasmInitPlugin,
} from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import type * as vite from "vite";

export type { CloudflarePluginOptions };

export default function cloudflareVitePlugin(
  options: CloudflarePluginOptions = {},
): Array<vite.Plugin | null> {
  return [
    optionsPlugin.vite(options),
    cloudflareExternalsPlugin.vite(options),
    nodejsAlsPlugin.vite(options),
    nodejsImportWarningPlugin.vite(options),
    nodejsUnenvPlugin.vite(options),
    virtualModulesPlugin.vite(options),
    wasmInitPlugin.vite(options),
    additionalModulesPlugin.vite(options),
    {
      name: "distilled-cloudflare:rsc",
      enforce: "pre",
      config() {
        return { rsc: { serverHandler: false } } as vite.UserConfig;
      },
    },
  ];
}
