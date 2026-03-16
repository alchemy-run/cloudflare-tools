import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type * as Stream from "effect/Stream";
import { SystemError, type BundleError } from "./errors.js";
import type { Module } from "./module.js";
import type { Rule } from "./module-rules.js";

/**
 * Cloudflare-specific bundle options shared across backend adapters.
 */
export interface CloudflareOptions {
  /** Absolute path to the entry point */
  readonly main: string;
  /** Absolute path to the project root */
  readonly projectRoot: string;
  /** Absolute path to the output directory */
  readonly outputDir: string;
  /** Cloudflare compatibility date */
  readonly compatibilityDate?: string;
  /** Cloudflare compatibility flags (e.g., ["nodejs_compat"]) */
  readonly compatibilityFlags?: ReadonlyArray<string>;
  /** esbuild define replacements */
  readonly define?: Record<string, string>;
  /** Module rules for non-JS imports */
  readonly rules?: ReadonlyArray<Rule>;
  /** Whether to scan the filesystem for additional modules */
  readonly findAdditionalModules?: boolean;
  /** Preserve original file names instead of content-hashing */
  readonly preserveFileNames?: boolean;
  /** Additional imports to mark as external */
  readonly external?: ReadonlyArray<string>;
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
  readonly modules: ReadonlyArray<Module>;
  /** The module format of the entry point */
  readonly type: "esm" | "commonjs";
  /** Absolute path to the output directory */
  readonly outputDir: string;
}

export class Bundle extends ServiceMap.Service<
  Bundle,
  {
    readonly build: (options: CloudflareOptions) => Effect.Effect<BundleResult, BundleError>;
    readonly watch: (
      options: CloudflareOptions,
    ) => Stream.Stream<Result.Result<BundleResult, BundleError>, BundleError, Scope.Scope>;
  }
>()("distilled-bundler/Bundle") {}

/**
 * Writes collected modules (WASM, text, data) as separate files to the
 * output directory, preserving any subdirectory structure.
 */
export const writeAdditionalModules = (modules: ReadonlyArray<Module>, directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* Effect.forEach(
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
  });
