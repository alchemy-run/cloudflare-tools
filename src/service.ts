/**
 * The Bundler service definition.
 *
 * `Bundler` is defined as a `ServiceMap.Service` — a bundler-agnostic
 * interface that can be satisfied by any bundler implementation (esbuild,
 * Rolldown, etc.) via an Effect `Layer`.
 *
 * @example
 * ```ts
 * import { Bundler } from "@distilled.cloud/cloudflare-bundler";
 * import { EsbuildBundler } from "@distilled.cloud/cloudflare-bundler/esbuild";
 * import { Effect } from "effect";
 *
 * // Use the Bundler service — implementation provided via Layer
 * const program = Bundler.use((bundler) =>
 *   bundler.bundle({
 *     entry: "./src/index.ts",
 *     outDir: "./dist",
 *   })
 * );
 *
 * await program.pipe(Effect.provide(EsbuildBundler), Effect.runPromise);
 * ```
 *
 * @module
 */
import { ServiceMap, type Effect } from "effect";
import type { BundleConfig } from "./config.js";
import type { BuildError, BuildResult } from "./types.js";

/**
 * The Bundler service interface.
 *
 * Implementations must provide a `bundle` method that takes a `BundleConfig`
 * and returns an `Effect` producing a `BuildResult`.
 */
export interface BundlerShape {
  readonly bundle: (config: BundleConfig) => Effect.Effect<BuildResult, BuildError>;
}

/**
 * The Bundler service tag.
 *
 * Use `Bundler.use(fn)` to access the bundler within an Effect program,
 * or yield it in a generator via `yield* Bundler`.
 */
export class Bundler extends ServiceMap.Service<Bundler, BundlerShape>()("@distilled.cloud/cloudflare-bundler/Bundler") {}
