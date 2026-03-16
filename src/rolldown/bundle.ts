import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  rolldown,
  type InputOptions,
  type OutputChunk,
  type OutputOptions,
  type Plugin,
  watch,
} from "rolldown";
import {
  Bundle,
  type BundleResult,
  type CloudflareOptions,
  writeAdditionalModules,
} from "../bundle.js";
import {
  collectAdditionalEntries,
  hasNodejsCompat,
  mapBuildError,
  readEmittedJavaScriptModules,
} from "../backend-utils.js";
import { deriveDefines, deriveFormat } from "../cloudflare-defaults.js";
import { BuildError, type BundleError } from "../errors.js";
import type { Module } from "../module.js";
import { cloudflareInternalPlugin } from "./plugins/cloudflare-internal.js";
import { createModuleCollector } from "./plugins/module-collector.js";
import { createNodejsCompat } from "./plugins/nodejs-compat.js";
import { nodejsCompatWarningPlugin } from "./plugins/nodejs-compat-warning.js";

export type RolldownBundleOptions = CloudflareOptions;

export const RolldownBundleLive = Layer.effect(
  Bundle,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const makeBuildOptions = Effect.fn(function* (options: CloudflareOptions) {
      const plugins: Array<Plugin> = [];
      const moduleCollector = createModuleCollector({
        rules: options.rules,
        preserveFileNames: options.preserveFileNames,
      });
      plugins.push(moduleCollector.plugin);

      let alias: Record<string, string> = {};
      let inject: Record<string, string | [string, string]> | undefined;

      if (hasNodejsCompat(options.compatibilityFlags)) {
        const compat = yield* Effect.promise(() =>
          createNodejsCompat({
            compatibilityDate: options.compatibilityDate,
            compatibilityFlags: options.compatibilityFlags,
          }),
        );
        plugins.push(compat.plugin);
        alias = compat.alias;
        inject = compat.transform.inject;
      } else {
        plugins.push(nodejsCompatWarningPlugin());
      }

      plugins.push(cloudflareInternalPlugin());

      const entries = yield* collectAdditionalEntries({
        options,
        fs,
        path,
        mainEntryName: path.basename(options.main, path.extname(options.main)),
      }).pipe(Effect.mapError(mapBuildError));

      const inputOptions = {
        input: options.findAdditionalModules ? entries : options.main,
        cwd: options.projectRoot,
        platform: "browser",
        plugins,
        external: (id) => {
          if (id === "__STATIC_CONTENT_MANIFEST") return true;
          return options.external?.includes(id) === true;
        },
        resolve: {
          alias,
          conditionNames: ["workerd", "worker", "browser", "import", "default"],
        },
        moduleTypes: {
          ".js": "jsx",
          ".mjs": "jsx",
          ".cjs": "jsx",
        },
        transform: {
          define: deriveDefines(options),
          ...(inject ? { inject } : {}),
        },
        tsconfig: options.tsconfig ? path.resolve(options.projectRoot, options.tsconfig) : true,
      } satisfies InputOptions;

      const outputOptions = {
        dir: options.outputDir,
        format: deriveFormat(options.format),
        sourcemap: true,
        minify: options.minify ?? false,
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
        codeSplitting: options.findAdditionalModules,
        keepNames: options.keepNames ?? true,
      } satisfies OutputOptions;

      return { inputOptions, outputOptions, moduleCollector };
    });

    const writeCopiedModules = (copiedModules: ReadonlyArray<Module>, entryDir: string) =>
      copiedModules.length > 0
        ? writeAdditionalModules(copiedModules, entryDir).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
        : Effect.void;

    return Bundle.of({
      build: Effect.fn(function* (options) {
        const { inputOptions, outputOptions, moduleCollector } = yield* makeBuildOptions(options);
        const bundle = yield* Effect.tryPromise({
          try: () => rolldown(inputOptions),
          catch: mapBuildError,
        });

        try {
          const output = yield* Effect.tryPromise({
            try: () => bundle.write(outputOptions),
            catch: mapBuildError,
          });

          const entryChunk = output.output.find(
            (item): item is OutputChunk => item.type === "chunk" && item.isEntry,
          );
          if (!entryChunk) {
            return yield* new BuildError({
              message: "Build failed to produce an entry chunk.",
              errors: [],
              warnings: [],
            });
          }

          const main = path.resolve(options.outputDir, entryChunk.fileName);
          const copiedModules = moduleCollector.getModules();
          yield* writeCopiedModules(copiedModules, path.dirname(main));

          const emittedModules: Array<Module> = output.output
            .filter(
              (item): item is OutputChunk =>
                item.type === "chunk" && path.resolve(options.outputDir, item.fileName) !== main,
            )
            .map((chunk) => ({
              name: chunk.fileName,
              path: path.resolve(options.outputDir, chunk.fileName),
              content: Buffer.from(chunk.code),
              type: chunk.fileName.endsWith(".cjs") ? "CommonJS" : ("ESModule" as Module.Type),
            }));

          return {
            main,
            modules: [...emittedModules, ...copiedModules],
            type: entryChunk.exports.length > 0 ? "esm" : "commonjs",
            outputDir: options.outputDir,
          } satisfies BundleResult;
        } finally {
          yield* Effect.promise(() => bundle.close()).pipe(Effect.ignore);
        }
      }),
      watch: (options) =>
        Stream.callback<Result.Result<BundleResult, BundleError>, never>((queue) =>
          Effect.gen(function* () {
            const { inputOptions, outputOptions, moduleCollector } =
              yield* makeBuildOptions(options);
            const watcher = watch({
              ...inputOptions,
              output: outputOptions,
              watch: {},
              experimental: { incrementalBuild: true },
            });

            watcher.on("event", async (event) => {
              if (event.code === "BUNDLE_END") {
                try {
                  const result = await Effect.runPromise(
                    Effect.gen(function* () {
                      const entryFile = `${path.basename(options.main, path.extname(options.main))}.js`;
                      const main = path.resolve(options.outputDir, entryFile);
                      const code = yield* fs.readFileString(main);
                      const copiedModules = moduleCollector.getModules();
                      yield* writeCopiedModules(copiedModules, path.dirname(main));
                      const emittedModules = yield* readEmittedJavaScriptModules({
                        fs,
                        path,
                        outputDir: options.outputDir,
                        main,
                      });

                      return {
                        main,
                        modules: [...emittedModules, ...copiedModules],
                        type: /\bexport[\s{]/.test(code) ? "esm" : "commonjs",
                        outputDir: options.outputDir,
                      } satisfies BundleResult;
                    }),
                  );
                  Queue.offerUnsafe(queue, Result.succeed(result));
                } catch (error) {
                  Queue.offerUnsafe(queue, Result.fail(mapBuildError(error)));
                } finally {
                  await event.result.close();
                }
              } else if (event.code === "ERROR") {
                Queue.offerUnsafe(queue, Result.fail(mapBuildError(event.error)));
                await event.result.close();
              }
            });

            return yield* Effect.addFinalizer(() =>
              Effect.promise(() => watcher.close()).pipe(Effect.ignore),
            );
          }).pipe(
            Effect.catch((error) => Queue.offer(queue, Result.fail(error)).pipe(Effect.asVoid)),
          ),
        ),
    });
  }),
);
