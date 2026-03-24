import * as Effect from "effect/Effect";
import { Miniflare } from "miniflare";
import * as path from "node:path";
import type { BundleConfig, BundleResult } from "./types.js";

export interface MiniflareRunnerOptions {
  readonly bundle: BundleResult;
  readonly config: BundleConfig;
  readonly bindings?: Record<string, unknown>;
}

export interface RunningWorker {
  readonly miniflare: Miniflare;
  readonly fetch: (
    url: string,
    init?: Parameters<Miniflare["dispatchFetch"]>[1],
  ) => Promise<Awaited<ReturnType<Miniflare["dispatchFetch"]>>>;
  readonly dispose: () => Promise<void>;
}

export function createRunner(
  options: MiniflareRunnerOptions,
): Effect.Effect<RunningWorker, Error, never> {
  return Effect.try({
    try: () => {
      const { bundle, config } = options;
      const modules = bundle.modules
        .filter((module) => module.type !== "SourceMap")
        .sort((left, right) => {
          if (left.name === bundle.main) return -1;
          if (right.name === bundle.main) return 1;
          return left.name.localeCompare(right.name);
        })
        .map((module) => ({
          type: module.type,
          path: path.resolve(bundle.outDir, module.name),
        }));
      const miniflareOptions: ConstructorParameters<typeof Miniflare>[0] = {
        modules,
        modulesRoot: bundle.outDir,
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: [...config.compatibilityFlags],
        bindings: options.bindings,
      };

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

export function withRunner<A>(
  options: MiniflareRunnerOptions,
  fn: (runner: RunningWorker) => Promise<A>,
): Effect.Effect<A, Error> {
  return Effect.acquireUseRelease(
    createRunner(options),
    (runner) => Effect.promise(() => fn(runner)),
    (runner) => Effect.promise(() => runner.dispose()),
  );
}
