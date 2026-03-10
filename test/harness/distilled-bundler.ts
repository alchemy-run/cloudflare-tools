/**
 * Distilled-bundler adapter for the test harness.
 *
 * Converts test harness BundleConfig into the bundler's BundleOptions,
 * runs the bundle, and converts the result back to test harness BundleResult.
 */
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BundleLive, Bundle, type BundleOptions } from "../../src/bundle.js";
import { BundleError } from "./bundle-error.js";
import type { BundleConfig, BundleResult } from "./types.js";
import type { Module } from "../../src/index.js";
import { Layer } from "effect";
import { EsbuildLive } from "../../src/esbuild.js";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";

const layers = Layer.provide(
  BundleLive,
  Layer.mergeAll(EsbuildLive, NodeFileSystem.layer, NodePath.layer),
);

/**
 * Bundles a fixture using distilled-bundler.
 */
export function bundleWithDistilled(
  config: BundleConfig,
): Effect.Effect<BundleResult, BundleError> {
  return Effect.gen(function* () {
    const bundle = yield* Bundle;
    // Create a temp directory for output
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "distilled-bundler-distilled-"));

    // Convert test harness config to bundler options
    const options: BundleOptions = {
      main: config.entryPoint,
      projectRoot: config.projectRoot,
      outputDir: outdir,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      define: config.define,
      rules: config.rules?.map((r) => ({
        type: r.type,
        globs: [...r.globs],
        fallthrough: r.fallthrough,
      })),
      findAdditionalModules: config.findAdditionalModules,
      preserveFileNames: config.preserveFileNames,
      external: config.external ? [...config.external] : undefined,
    };

    // Run the bundle
    const result = yield* bundle.bundle(options).pipe(
      Effect.mapError(
        (error) =>
          new BundleError({
            message: `Distilled bundler failed: ${String(error)}`,
            cause: error,
          }),
      ),
    );

    // Convert to test harness BundleResult
    // filePath must point to the written output file (used by Miniflare to load from disk)
    const entryDir = path.dirname(result.main);
    return {
      main: result.main,
      modules: result.modules.map(
        (m): Module => ({
          name: m.name,
          path: path.resolve(entryDir, m.name),
          content: m.content,
          type: m.type,
        }),
      ),
      type: result.type,
      outputDir: result.outputDir,
    } satisfies BundleResult;
  }).pipe(Effect.provide(layers));
}
