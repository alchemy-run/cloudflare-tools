import type { RolldownPluginOption } from "rolldown";
import { makeAdditionalModulesPlugin } from "./plugins/additional-modules";
import { cloudflareExternalsPlugin } from "./plugins/cloudflare-externals";
import { makeNodejsCompatPlugin } from "./plugins/nodejs-compat";
import { optionsPlugin } from "./plugins/options";
import { wasmInitPlugin } from "./plugins/wasm-init";

export interface CloudflarePluginOptions {
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
}

export type CloudflarePlugin = (options: CloudflarePluginOptions) => RolldownPluginOption;

const cloudflarePlugin: CloudflarePlugin = async (options?: CloudflarePluginOptions) => {
  return [
    optionsPlugin,
    cloudflareExternalsPlugin,
    makeNodejsCompatPlugin(options ?? {}),
    wasmInitPlugin,
    makeAdditionalModulesPlugin(),
  ];
};

export default cloudflarePlugin;
