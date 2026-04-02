import type { Plugin } from "rolldown";
import type { CloudflarePluginOptions } from "../plugin.js";
import { hasNodejsCompat } from "../utils.js";

const DEFAULT_RESOLVE_CONDITION_NAMES = ["workerd", "worker", "module", "browser", "production"];

const DEFAULT_RESOLVE_EXTENSIONS = [
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".cjs",
  ".cts",
  ".ctx",
];

export function makeOptionsPlugin(pluginOptions: CloudflarePluginOptions) {
  return {
    name: "rolldown-plugin-cloudflare:options",
    options(options) {
      options.platform ??= "neutral";
      options.resolve ??= {};
      options.resolve.conditionNames ??= DEFAULT_RESOLVE_CONDITION_NAMES;
      options.resolve.extensions ??= DEFAULT_RESOLVE_EXTENSIONS;
      options.transform ??= {};
      options.transform.target ??= "es2024";
      options.transform.define ??= {};
      Object.assign(options.transform.define, {
        "process.env.NODE_ENV": '"production"',
        "global.process.env.NODE_ENV": '"production"',
        "globalThis.process.env.NODE_ENV": '"production"',
        ...(hasNodejsCompat(pluginOptions.compatibilityFlags)
          ? {}
          : {
              "process.env": "{}",
              "global.process.env": "{}",
              "globalThis.process.env": "{}",
            }),
        ...(pluginOptions.compatibilityDate && pluginOptions.compatibilityDate >= "2022-03-21"
          ? {
              "navigator.userAgent": '"Cloudflare-Workers"',
            }
          : {}),
      });
      return options;
    },
  } satisfies Plugin;
}
