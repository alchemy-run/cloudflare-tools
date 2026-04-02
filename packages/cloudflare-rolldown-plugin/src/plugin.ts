import type { RolldownPluginOption } from "rolldown";
import { makeAdditionalModulesPlugin } from "./plugins/additional-modules.js";
import { cloudflareExternalsPlugin } from "./plugins/cloudflare-externals.js";
import { makeNodejsCompatPlugin } from "./plugins/nodejs-compat.js";
import { makeOptionsPlugin } from "./plugins/options.js";
import { wasmInitPlugin } from "./plugins/wasm-init.js";

export interface CloudflarePluginOptions {
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
}

export type CloudflarePlugin = (options?: CloudflarePluginOptions) => RolldownPluginOption;

const cloudflare: CloudflarePlugin = async (options = {}) => {
  return [
    makeOptionsPlugin(options),
    cloudflareExternalsPlugin,
    makeNodejsCompatPlugin(options),
    wasmInitPlugin,
    makeAdditionalModulesPlugin(),
  ];
};

export default cloudflare;
