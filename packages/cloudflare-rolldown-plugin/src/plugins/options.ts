import type { Plugin } from "rolldown";

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

export const optionsPlugin: Plugin = {
  name: "rolldown-plugin-cloudflare:options",
  options(options) {
    options.platform ??= "neutral";
    options.resolve ??= {};
    options.resolve.conditionNames ??= DEFAULT_RESOLVE_CONDITION_NAMES;
    options.resolve.extensions ??= DEFAULT_RESOLVE_EXTENSIONS;
    options.transform ??= {};
    options.transform.target ??= "es2024";
    return options;
  },
};
