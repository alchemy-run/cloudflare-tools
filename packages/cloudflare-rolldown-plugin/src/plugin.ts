import type { Plugin } from "rolldown";
import {
  additionalModulesPlugin,
  cloudflareExternalsPlugin,
  nodejsAlsPlugin,
  nodejsImportWarningPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
  wasmInitPlugin,
} from "./plugins/index.js";

export interface CloudflarePluginOptions {
  compatibilityDate?: string;
  compatibilityFlags?: Array<string>;
}

export type CloudflarePlugin = (options?: CloudflarePluginOptions) => Array<Plugin | null>;

const cloudflare: CloudflarePlugin = (options = {}) => {
  return [
    optionsPlugin.rolldown(options),
    cloudflareExternalsPlugin.rolldown(options),
    nodejsAlsPlugin.rolldown(options),
    nodejsImportWarningPlugin.rolldown(options),
    nodejsUnenvPlugin.rolldown(options),
    virtualModulesPlugin.rolldown(options),
    wasmInitPlugin.rolldown(options),
    additionalModulesPlugin.rolldown(options),
  ];
};

export default cloudflare;
