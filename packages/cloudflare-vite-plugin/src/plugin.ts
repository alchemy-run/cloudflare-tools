import {
  additionalModulesPlugin,
  buildManifestPlugin,
  cloudflareExternalsPlugin,
  nodejsAlsPlugin,
  nodejsImportWarningPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
  wasmInitPlugin,
} from "@distilled.cloud/cloudflare-rolldown-plugin/plugins";
import type * as vite from "vite";
import { dev } from "./dev-plugin.js";
import {
  normalizeCloudflareVitePluginOptions,
  type CloudflareVitePluginOptions,
} from "./options.js";

export type {
  CloudflareViteAssetsOptions,
  CloudflareVitePluginOptions,
  CloudflareViteWorkerOptions,
} from "./options.js";

export default function cloudflareVitePlugin(
  options: CloudflareVitePluginOptions = {},
): Array<vite.Plugin | null> {
  const resolvedOptions = normalizeCloudflareVitePluginOptions(options);

  return [
    optionsPlugin.vite(resolvedOptions),
    cloudflareExternalsPlugin.vite(resolvedOptions),
    nodejsAlsPlugin.vite(resolvedOptions),
    nodejsImportWarningPlugin.vite(resolvedOptions),
    nodejsUnenvPlugin.vite(resolvedOptions),
    virtualModulesPlugin.vite(resolvedOptions),
    wasmInitPlugin.vite(resolvedOptions),
    additionalModulesPlugin.vite(resolvedOptions),
    {
      name: "distilled-cloudflare:rsc",
      enforce: "pre",
      config() {
        return { rsc: { serverHandler: false } } as vite.UserConfig;
      },
    } as vite.Plugin,
    buildManifestPlugin(resolvedOptions),
    dev(resolvedOptions),
  ];
}
