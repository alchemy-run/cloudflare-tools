import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Bundler from "../../src/Bundler.js";
import { RolldownBundler } from "../../src/rolldown/index.js";
import { BundleError } from "./bundle-error.js";
import type { BundleConfig, BundleResult } from "./types.js";

const layers = Layer.provide(RolldownBundler, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

export function bundleWithRolldown(config: BundleConfig): Effect.Effect<BundleResult, BundleError> {
  return Effect.gen(function* () {
    const bundler = yield* Bundler.Bundler;
    const outDir = yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory({
        prefix: "distilled-bundler-rolldown-",
      });
    }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.mapError(
        (cause) =>
          new BundleError({
            message: `Failed to create rolldown temp directory: ${String(cause)}`,
            cause,
          }),
      ),
    );

    return yield* bundler
      .build({
        main: config.entryPoint,
        rootDir: config.projectRoot,
        outDir,
        define: config.define,
        external: config.external ? [...config.external] : undefined,
        minify: config.minify,
        keepNames: config.keepNames,
        tsconfig: config.tsconfig,
        cloudflare: {
          compatibilityDate: config.compatibilityDate,
          compatibilityFlags: config.compatibilityFlags,
          additionalModules: {
            rules: config.rules,
            preserveFileNames: config.preserveFileNames,
          },
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BundleError({
              message: `Rolldown bundler failed: ${String(cause)}`,
              cause,
            }),
        ),
      );
  }).pipe(Effect.provide(layers));
}
