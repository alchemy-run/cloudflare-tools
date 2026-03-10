/**
 * Miniflare runner for testing bundled Workers.
 *
 * Loads a BundleResult into Miniflare (workerd) and provides
 * methods to dispatch fetch requests against the running Worker.
 *
 * Uses Effect's Scope for resource management — Miniflare is automatically
 * disposed when the scope closes.
 */
import * as Effect from "effect/Effect";
import { Miniflare } from "miniflare";
import type { BundleConfig, BundleResult, CfModule } from "./types.js";
import { CfModuleTypeToMiniflare } from "./types.js";

/**
 * Options for creating a Miniflare runner.
 */
export interface MiniflareRunnerOptions {
  /** The bundle to load */
  readonly bundle: BundleResult;
  /** The original bundle config (for compat flags, etc.) */
  readonly config: BundleConfig;
  /** Additional bindings to provide (e.g., KV namespaces, D1, etc.) */
  readonly bindings?: Record<string, unknown>;
}

/**
 * A running Miniflare instance with convenience methods.
 */
export interface RunningWorker {
  /** The underlying Miniflare instance */
  readonly miniflare: Miniflare;
  /** Dispatch a fetch request to the Worker */
  readonly fetch: (
    url: string,
    init?: Parameters<Miniflare["dispatchFetch"]>[1],
  ) => Promise<Awaited<ReturnType<Miniflare["dispatchFetch"]>>>;
  /** Dispose the Miniflare instance */
  readonly dispose: () => Promise<void>;
}

/**
 * Creates a Miniflare instance from a BundleResult.
 *
 * The Miniflare instance loads the bundled entry point and any additional
 * modules (WASM, text, data). It's configured with the same compatibility
 * date and flags as the original fixture.
 *
 * Returns a scoped Effect that automatically disposes Miniflare when done.
 */
export function createRunner(
  options: MiniflareRunnerOptions,
): Effect.Effect<RunningWorker, Error, never> {
  return Effect.try({
    try: () => {
      const { bundle, config } = options;

      // Build the modules array for Miniflare
      const modules: Array<{
        type: string;
        path: string;
      }> = [
        // Entry point
        {
          type: bundle.bundleType === "esm" ? "ESModule" : "CommonJS",
          path: bundle.entryPoint,
        },
        // Additional modules (WASM, text, data, etc.)
        ...bundle.modules.map((mod: CfModule) => ({
          type: CfModuleTypeToMiniflare[mod.type],
          path: mod.filePath,
        })),
      ];

      // Build Miniflare options
      const miniflareOptions: ConstructorParameters<typeof Miniflare>[0] = {
        modules,
        modulesRoot: bundle.outputDir,
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: [...config.compatibilityFlags],
        bindings: options.bindings,
      };

      // Add Durable Object bindings if present
      if (config.durableObjects && config.durableObjects.length > 0) {
        const durableObjects: Record<string, string> = {};
        for (const binding of config.durableObjects) {
          durableObjects[binding.name] = binding.class_name;
        }
        Object.assign(miniflareOptions, { durableObjects });
      }

      const miniflare = new Miniflare(miniflareOptions);

      const runner: RunningWorker = {
        miniflare,
        fetch: (url, init) => miniflare.dispatchFetch(url, init),
        dispose: () => miniflare.dispose(),
      };

      return runner;
    },
    catch: (error) =>
      new Error(
        `Failed to create Miniflare runner: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

/**
 * Creates a Miniflare runner, executes a function against it, and disposes.
 *
 * This is the primary way to use the runner in tests:
 * ```ts
 * yield* withRunner({ bundle, config }, async (runner) => {
 *   const res = await runner.fetch("http://localhost/test")
 *   expect(res.status).toBe(200)
 * })
 * ```
 */
export function withRunner(
  options: MiniflareRunnerOptions,
  fn: (runner: RunningWorker) => Promise<void>,
): Effect.Effect<void, Error> {
  return Effect.acquireUseRelease(
    createRunner(options),
    (runner) => Effect.promise(() => fn(runner)),
    (runner) => Effect.promise(() => runner.dispose()),
  );
}
