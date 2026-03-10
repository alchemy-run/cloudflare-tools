/**
 * Main bundle orchestrator.
 *
 * Assembles esbuild options and plugins, runs the build via the Esbuild
 * Effect service, and post-processes the result into a BundleResult.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as ServiceMap from "effect/ServiceMap";
import type { Plugin } from "esbuild";
import { Esbuild, type EsbuildError } from "./esbuild.js";
import { getEntryPointFromMetafile, type MetafileError } from "./metafile.js";
import type { Module } from "./module.js";
import { cloudflareInternalPlugin } from "./plugins/cloudflare-internal.js";
import { createModuleCollector, type Rule } from "./plugins/module-collector.js";
import { nodejsCompatPlugin } from "./plugins/nodejs-compat.js";

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

export class BundleFileSystemError extends Data.TaggedError("BundleFileSystemError")<{
  readonly cause: PlatformError;
}> {}

export class BundleEsbuildError extends Data.TaggedError("BundleEsbuildError")<{
  readonly cause: EsbuildError;
}> {}

export class BundleMetafileError extends Data.TaggedError("BundleMetafileError")<{
  readonly cause: MetafileError;
}> {}

export type BundleError = BundleEsbuildError | BundleMetafileError | BundleFileSystemError;

export class Bundle extends ServiceMap.Service<
  Bundle,
  {
    readonly bundle: (options: BundleOptions) => Effect.Effect<BundleResult, BundleError>;
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
    const esbuild = yield* Esbuild;
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
            Effect.mapError((cause) => new BundleFileSystemError({ cause })),
          );
        },
        { discard: true },
      );

    return Bundle.of({
      bundle: (options) =>
        Effect.gen(function* () {
          const plugins = createPlugins(options);
          const moduleCollector = plugins.moduleCollector;

          const result = yield* esbuild
            .build({
              // Common esbuild options matching wrangler's configuration.
              target: "es2024",
              conditions: ["workerd", "worker", "browser"],
              define: {
                "process.env.NODE_ENV": '"production"',
                "global.process.env.NODE_ENV": '"production"',
                "globalThis.process.env.NODE_ENV": '"production"',
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
              format: "esm",
              sourcemap: true,
              metafile: true,
              logLevel: "silent",
              external: [...(options.external ?? [])],
              plugins: plugins.plugins,
            })
            .pipe(Effect.mapError((cause) => new BundleEsbuildError({ cause })));

          const entryPointInfo = yield* getEntryPointFromMetafile(
            options.main,
            result.metafile,
          ).pipe(Effect.mapError((cause) => new BundleMetafileError({ cause })));

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
        }),
    });
  }),
);

function createPlugins(options: BundleOptions): {
  readonly moduleCollector: ReturnType<typeof createModuleCollector>;
  readonly plugins: Array<Plugin>;
} {
  const plugins: Array<Plugin> = [];
  const moduleCollector = createModuleCollector({
    rules: options.rules ? [...options.rules] : undefined,
    preserveFileNames: options.preserveFileNames,
  });
  plugins.push(moduleCollector.plugin);

  const hasNodejsCompat = options.compatibilityFlags?.some(
    (flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2",
  );
  if (hasNodejsCompat) {
    plugins.push(
      nodejsCompatPlugin({
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: options.compatibilityFlags,
      }),
    );
  }

  plugins.push(cloudflareInternalPlugin);

  return { moduleCollector, plugins };
}
