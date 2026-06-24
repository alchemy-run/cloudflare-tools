import type * as rolldown from "rolldown";
import type { BasePluginOptions } from "./options.js";
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

export type RolldownPluginOptions = Omit<BasePluginOptions, "viteEnvironment">;

export type RolldownPlugin = (options?: RolldownPluginOptions) => Array<rolldown.Plugin | null>;

const cloudflare: RolldownPlugin = (options = {}) => {
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
