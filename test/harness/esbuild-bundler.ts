/**
 * Esbuild adapter for the test harness.
 *
 * Converts test harness BundleConfig into the shared Cloudflare options,
 * runs the bundle through the esbuild backend, and converts the result back
 * to test harness BundleResult.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Bundle, type CloudflareOptions } from "../../src/bundle.js";
import { EsbuildBundleLive } from "../../src/esbuild/index.js";
import type { Module } from "../../src/index.js";
import { BundleError } from "./bundle-error.js";
import type { BundleConfig, BundleResult } from "./types.js";

const layers = Layer.provide(EsbuildBundleLive, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

export function bundleWithEsbuild(config: BundleConfig): Effect.Effect<BundleResult, BundleError> {
  return Effect.gen(function* () {
    const bundle = yield* Bundle;
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "distilled-bundler-esbuild-"));

    const options: CloudflareOptions = {
      main: config.entryPoint,
      projectRoot: config.projectRoot,
      outputDir: outdir,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      define: config.define,
      rules: config.rules?.map((rule) => ({
        type: rule.type,
        globs: [...rule.globs],
        fallthrough: rule.fallthrough,
      })),
      findAdditionalModules: config.findAdditionalModules,
      preserveFileNames: config.preserveFileNames,
      external: config.external ? [...config.external] : undefined,
      minify: config.minify,
      keepNames: config.keepNames,
      tsconfig: config.tsconfig,
      format: config.format,
    };

    const result = yield* bundle.build(options).pipe(
      Effect.mapError(
        (error) =>
          new BundleError({
            message: `Esbuild bundler failed: ${String(error)}`,
            cause: error,
          }),
      ),
    );

    const entryDir = path.dirname(result.main);
    return {
      main: result.main,
      modules: result.modules.map(
        (module): Module => ({
          name: module.name,
          path: path.resolve(entryDir, module.name),
          content: module.content,
          type: module.type,
        }),
      ),
      type: result.type,
      outputDir: result.outputDir,
    } satisfies BundleResult;
  }).pipe(Effect.provide(layers));
}
