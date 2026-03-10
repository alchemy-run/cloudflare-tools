/**
 * Bundler-agnostic adapter interface.
 *
 * Each bundler backend (esbuild, rolldown, etc.) provides a Layer
 * that implements this service. Tests parameterize over adapters to
 * verify that all bundlers produce correct output.
 */
import * as ServiceMap from "effect/ServiceMap";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { BundleConfig, BundleResult } from "./types.js";

/**
 * Error type for bundling failures.
 */
export class BundleError extends Data.TaggedError("BundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The BundlerAdapter service tag.
 *
 * Any bundler implementation must provide:
 * - `bundle(config)`: Takes a BundleConfig and produces a BundleResult
 *
 * The result includes the entry point path, additional modules, and
 * the output directory — everything needed to load the bundle into Miniflare.
 */
export class BundlerAdapter extends ServiceMap.Service<
  BundlerAdapter,
  {
    readonly bundle: (config: BundleConfig) => Effect.Effect<BundleResult, BundleError>;
  }
>()("test/BundlerAdapter") {}
