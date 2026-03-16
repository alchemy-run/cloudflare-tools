import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as esbuild from "esbuild";
import {
  Bundle,
  type BundleResult,
  type CloudflareOptions,
  writeAdditionalModules,
} from "../bundle.js";
import {
  deriveConditions,
  deriveDefines,
  deriveFormat,
  deriveLoader,
} from "../cloudflare-defaults.js";
import { BuildError } from "../errors.js";
import { cloudflareInternalPlugin } from "./plugins/cloudflare-internal.js";
import { createModuleCollector } from "./plugins/module-collector.js";
import { nodejsCompatWarningPlugin } from "./plugins/nodejs-compat-warning.js";
import { nodejsCompatPlugin } from "./plugins/nodejs-compat.js";
import { makeWatchPlugin } from "./plugins/watch.js";
import { getEntryPointFromMetafile } from "./metafile.js";

export type EsbuildBundleOptions = CloudflareOptions;

export const EsbuildBundleLive = Layer.effect(
  Bundle,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const build = <T extends esbuild.BuildOptions>(
      options: esbuild.SameShape<esbuild.BuildOptions, T>,
    ): Effect.Effect<esbuild.BuildResult<T>, BuildError> =>
      Effect.tryPromise({
        try: () => esbuild.build(options),
        catch: mapBuildError,
      });

    const watch = <T extends esbuild.BuildOptions>(
      options: esbuild.SameShape<esbuild.BuildOptions, T>,
    ): Stream.Stream<esbuild.BuildResult<T>, BuildError> =>
      Stream.callback((queue) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const context = await esbuild.context({
                ...options,
                plugins: [...(options.plugins ?? []), makeWatchPlugin(queue)],
              });
              await context.watch();
              return context;
            },
            catch: mapBuildError,
          }),
          (context) => Effect.promise(() => context.dispose()),
        ),
      );

    const makeBuildOptions = (options: CloudflareOptions) => {
      const plugins: Array<esbuild.Plugin> = [];
      const moduleCollector = createModuleCollector({
        rules: options.rules,
        preserveFileNames: options.preserveFileNames,
      });
      plugins.push(moduleCollector.plugin);

      if (
        options.compatibilityFlags?.some(
          (flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2",
        )
      ) {
        plugins.push(
          nodejsCompatPlugin({
            compatibilityDate: options.compatibilityDate,
            compatibilityFlags: options.compatibilityFlags,
          }),
        );
      } else {
        plugins.push(nodejsCompatWarningPlugin);
      }

      plugins.push(cloudflareInternalPlugin);

      const buildOptions = {
        target: "es2024",
        conditions: deriveConditions(),
        define: deriveDefines(options),
        loader: deriveLoader(),
        entryPoints: [options.main],
        bundle: true,
        absWorkingDir: options.projectRoot,
        outdir: options.outputDir,
        format: deriveFormat(options.format),
        sourcemap: true,
        metafile: true,
        logLevel: "silent",
        external: ["__STATIC_CONTENT_MANIFEST", ...(options.external ?? [])],
        plugins,
        minify: options.minify,
        keepNames: options.keepNames ?? true,
        tsconfig: options.tsconfig
          ? path.resolve(options.projectRoot, options.tsconfig)
          : undefined,
      } satisfies esbuild.BuildOptions;

      const mapBuildResult = Effect.fn(function* (
        result: esbuild.BuildResult<typeof buildOptions>,
      ) {
        if (result.errors.length > 0) {
          return yield* new BuildError({
            message: `Build failed with ${result.errors.length} error(s) and ${result.warnings.length} warning(s)`,
            errors: result.errors,
            warnings: result.warnings,
          });
        }

        const entryPointInfo = yield* getEntryPointFromMetafile(result.metafile);
        const resolvedEntryPoint = path.resolve(options.outputDir, entryPointInfo.relativePath);
        const modules = moduleCollector.getModules();

        if (modules.length > 0) {
          yield* writeAdditionalModules(modules, path.dirname(resolvedEntryPoint)).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
        }

        return {
          main: resolvedEntryPoint,
          modules,
          type: entryPointInfo.exports.length > 0 ? "esm" : "commonjs",
          outputDir: options.outputDir,
        } satisfies BundleResult;
      });

      return { buildOptions, mapBuildResult };
    };

    return Bundle.of({
      build: Effect.fn(function* (options) {
        const { buildOptions, mapBuildResult } = makeBuildOptions(options);
        const result = yield* build(buildOptions);
        return yield* mapBuildResult(result);
      }),
      watch: (options) => {
        const { buildOptions, mapBuildResult } = makeBuildOptions(options);
        return watch(buildOptions).pipe(
          Stream.mapEffect((result) => convertEffectToResult(mapBuildResult(result))),
        );
      },
    });
  }),
);

const mapBuildError = (cause: unknown): BuildError => {
  const error = cause as esbuild.BuildFailure;
  return new BuildError({
    message: error.message,
    errors: error.errors,
    warnings: error.warnings,
  });
};

const convertEffectToResult = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<Result.Result<A, E>> =>
  effect.pipe(
    Effect.map((success) => Result.succeed(success)),
    Effect.catch((error) => Effect.succeed(Result.fail(error))),
  );
