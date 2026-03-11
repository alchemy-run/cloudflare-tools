/**
 * Main bundle orchestrator.
 *
 * Assembles esbuild options and plugins, runs the build via the Esbuild
 * Effect service, and post-processes the result into a BundleResult.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as esbuild from "esbuild";
import { BuildError, SystemError, type BundleError } from "./errors.js";
import { getEntryPointFromMetafile } from "./metafile.js";
import type { Module } from "./module.js";
import { cloudflareInternalPlugin } from "./plugins/cloudflare-internal.js";
import { createModuleCollector, type Rule } from "./plugins/module-collector.js";
import { nodejsCompatWarningPlugin } from "./plugins/nodejs-compat-warning.js";
import { nodejsCompatPlugin } from "./plugins/nodejs-compat.js";
import { makeWatchPlugin } from "./plugins/watch.js";

export interface BundleOptions {
  /** Absolute path to the entry point */
  readonly main: string;
  /** Absolute path to the project root */
  readonly projectRoot: string;
  /** Absolute path to the output directory */
  readonly outputDir: string;
  /** Cloudflare compatibility date */
  readonly compatibilityDate?: string;
  /** Cloudflare compatibility flags (e.g., ["nodejs_compat"]) */
  readonly compatibilityFlags?: readonly string[];
  /** esbuild define replacements */
  readonly define?: Record<string, string>;
  /** Module rules for non-JS imports */
  readonly rules?: readonly Rule[];
  /** Whether to scan the filesystem for additional modules */
  readonly findAdditionalModules?: boolean;
  /** Preserve original file names instead of content-hashing */
  readonly preserveFileNames?: boolean;
  /** Additional imports to mark as external */
  readonly external?: readonly string[];
  /** Whether to minify the output */
  readonly minify?: boolean;
  /** Whether to preserve function/class names (default: true, matching wrangler) */
  readonly keepNames?: boolean;
  /** Path to tsconfig.json (absolute or relative to projectRoot) */
  readonly tsconfig?: string;
  /** Module format: "modules" (ESM) or "service-worker" (IIFE) */
  readonly format?: "modules" | "service-worker";
}

export interface BundleResult {
  /** Absolute path to the main output file */
  readonly main: string;
  /** Additional modules collected during bundling */
  readonly modules: readonly Module[];
  /** The module format of the entry point */
  readonly type: "esm" | "commonjs";
  /** Absolute path to the output directory */
  readonly outputDir: string;
}

export class Bundle extends ServiceMap.Service<
  Bundle,
  {
    readonly build: (options: BundleOptions) => Effect.Effect<BundleResult, BundleError>;
    readonly watch: (
      options: BundleOptions,
    ) => Stream.Stream<Result.Result<BundleResult, BundleError>, BundleError, Scope.Scope>;
  }
>()("distilled-bundler/Bundle") {}

/**
 * Bundles a Cloudflare Worker entry point using esbuild.
 *
 * Effectful bundle service entrypoint.
 */
export const BundleLive = Layer.effect(
  Bundle,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /**
     * Writes collected modules (WASM, text, data) as separate files
     * to the output directory, preserving any subdirectory structure.
     */
    const writeAdditionalModules = (modules: readonly Module[], directory: string) =>
      Effect.forEach(
        modules,
        (module) => {
          const target = path.resolve(directory, module.name);
          return fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
            Effect.andThen(() => fs.writeFile(target, module.content)),
            Effect.mapError(
              (cause) =>
                new SystemError({
                  message: `Failed to copy module "${module.name}" to "${directory}"`,
                  cause,
                }),
            ),
          );
        },
        { discard: true },
      );

    const build = <T extends esbuild.BuildOptions>(
      options: esbuild.SameShape<esbuild.BuildOptions, T>,
    ): Effect.Effect<esbuild.BuildResult<T>, BuildError> =>
      Effect.tryPromise({
        try: () => esbuild.build(options),
        catch: mapBuildError,
      });

    const mapBuildError = (cause: unknown): BuildError => {
      const e = cause as esbuild.BuildFailure;
      return new BuildError({
        message: e.message,
        errors: e.errors,
        warnings: e.warnings,
      });
    };

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

    const makeBuildOptions = (options: BundleOptions) => {
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
        // Without nodejs_compat, mark node:* imports as external but warn.
        // This matches wrangler's behavior: the build succeeds but the worker
        // may throw at runtime if it actually uses the node built-in.
        plugins.push(nodejsCompatWarningPlugin);
      }

      plugins.push(cloudflareInternalPlugin);

      const buildOptions = {
        // Common esbuild options matching wrangler's configuration.
        target: "es2024",
        conditions: ["workerd", "worker", "browser"],
        define: {
          "process.env.NODE_ENV": '"production"',
          "global.process.env.NODE_ENV": '"production"',
          "globalThis.process.env.NODE_ENV": '"production"',
          ...(options.compatibilityDate && options.compatibilityDate >= "2022-03-21"
            ? { "navigator.userAgent": '"Cloudflare-Workers"' }
            : {}),
          ...options.define,
        },
        loader: {
          ".js": "jsx",
          ".mjs": "jsx",
          ".cjs": "jsx",
        },

        entryPoints: [options.main],
        bundle: true,
        absWorkingDir: options.projectRoot,
        outdir: options.outputDir,
        format: options.format === "service-worker" ? "iife" : "esm",
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
          yield* writeAdditionalModules(modules, path.dirname(resolvedEntryPoint));
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

const convertEffectToResult = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<Result.Result<A, E>> =>
  effect.pipe(
    Effect.map((a) => Result.succeed(a)),
    Effect.catch((e) => Effect.succeed(Result.fail(e))),
  );
