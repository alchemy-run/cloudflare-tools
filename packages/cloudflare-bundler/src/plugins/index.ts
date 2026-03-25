import type { Plugin, RolldownOutput } from "rolldown";
import type { Input } from "../Input.js";
import type { Module } from "../Module.js";
import { createAdditionalModulesPlugin } from "./additional-modules.js";
import { cloudflareExternalsPlugin } from "./cloudflare-externals.js";
import { createNodejsCompatWarningsPlugin } from "./nodejs-compat-warnings.js";
import { createNodejsCompatPlugin } from "./nodejs-compat.js";
import { wasmHelperPlugin } from "./wasm-helper.js";

const hasNodejsCompat = (flags?: ReadonlyArray<string>) =>
  flags?.some((flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2") ?? false;

export interface PluginChain {
  readonly entryId: string;
  readonly plugins: ReadonlyArray<Plugin>;
  readonly rewriteAdditionalModules: (
    output: RolldownOutput,
    directory: string,
  ) => Promise<ReadonlyArray<Module>>;
  readonly getWarnings: () => ReadonlyArray<string>;
}

export async function createPluginChain(options: Input): Promise<PluginChain> {
  const additionalModules = createAdditionalModulesPlugin(options.cloudflare?.additionalModules);
  const warnings = hasNodejsCompat(options.cloudflare?.compatibilityFlags)
    ? undefined
    : await createNodejsCompatWarningsPlugin();
  const nodejsCompat = hasNodejsCompat(options.cloudflare?.compatibilityFlags)
    ? await createNodejsCompatPlugin({
        entry: options.main,
        ...(options.cloudflare?.compatibilityDate
          ? { compatibilityDate: options.cloudflare.compatibilityDate }
          : {}),
        ...(options.cloudflare?.compatibilityFlags
          ? { compatibilityFlags: options.cloudflare.compatibilityFlags }
          : {}),
      })
    : undefined;

  return {
    entryId: nodejsCompat?.entryId ?? options.main,
    plugins: [
      cloudflareExternalsPlugin(),
      ...additionalModules.plugins,
      wasmHelperPlugin(),
      ...(nodejsCompat ? [nodejsCompat.plugin] : []),
      ...(warnings ? [warnings.plugin] : []),
    ],
    rewriteAdditionalModules: (output, directory) => additionalModules.rewrite(output, directory),
    getWarnings: () => warnings?.getWarnings() ?? [],
  };
}
