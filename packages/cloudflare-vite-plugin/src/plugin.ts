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
import type {
  BindingHooks,
  DurableObjectNamespace,
  RuntimeServices,
} from "@distilled.cloud/cloudflare-runtime";
import type * as Context from "effect/Context";
import type * as vite from "vite";
import { dev } from "./dev-plugin.js";

export interface CloudflareVitePluginOptions<
  B extends BindingHooks = BindingHooks,
> extends CloudflarePluginOptions {
  durableObjectNamespaces?: Array<DurableObjectNamespace>;
  bindings?: B;
  context?: Context.Context<RuntimeServices>;
}

export default function cloudflareVitePlugin(
  options: CloudflareVitePluginOptions = {},
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
    } as vite.Plugin,
    dev(options),
  ];
}
