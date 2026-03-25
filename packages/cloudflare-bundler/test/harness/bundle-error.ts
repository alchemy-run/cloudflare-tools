/**
 * Bundler-agnostic adapter interface.
 *
 * Each bundler backend (esbuild, rolldown, etc.) provides a Layer
 * that implements this service. Tests parameterize over adapters to
 * verify that all bundlers produce correct output.
 */
import * as Data from "effect/Data";

/**
 * Error type for bundling failures.
 */
export class BundleError extends Data.TaggedError("BundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
