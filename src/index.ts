/**
 * @distilled.cloud/cloudflare-bundler
 *
 * Effect-native, bundler-agnostic bundler for Cloudflare Workers.
 *
 * @example
 * ```ts
 * import { Bundler } from "@distilled.cloud/cloudflare-bundler";
 * import { EsbuildBundler } from "@distilled.cloud/cloudflare-bundler/esbuild";
 * import { Effect } from "effect";
 *
 * const result = await Bundler.bundle({
 *   entry: "./src/index.ts",
 *   outDir: "./dist",
 *   compatibilityDate: "2025-01-01",
 *   compatibilityFlags: ["nodejs_compat_v2"],
 * }).pipe(
 *   Effect.provide(EsbuildBundler),
 *   Effect.runPromise,
 * );
 * ```
 *
 * @module
 */
export type { BundleConfig, ModuleRule } from "./config.js";
export { DEFAULT_MODULE_RULES } from "./config.js";
export type { AdditionalModule, BuildError, BuildResult, ModuleType } from "./types.js";
export { Bundler } from "./service.js";
