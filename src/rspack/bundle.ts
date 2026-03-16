import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import globToRegExp from "glob-to-regexp";
import {
  DefinePlugin,
  ProvidePlugin,
  rspack,
  sources,
  type Compiler,
  type Plugin,
  type ProvidePluginOptions,
  type RspackOptions,
  type Stats,
} from "@rspack/core";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  Bundle,
  type BundleResult,
  type CloudflareOptions,
  writeAdditionalModules,
} from "../bundle.js";
import {
  collectAdditionalEntries,
  hasNodejsCompat,
  readEmittedJavaScriptModules,
} from "../backend-utils.js";
import { deriveDefines } from "../cloudflare-defaults.js";
import { BuildError, type BundleError } from "../errors.js";
import { ModuleCollectorCore } from "../module-collector.js";
import { parseRules } from "../module-rules.js";
import type { Module } from "../module.js";
import { resolveUnenv } from "../nodejs-compat-env.js";

export type RspackBundleOptions = CloudflareOptions;
const require = createRequire(import.meta.url);

const textLoaderPath = fileURLToPath(new URL("./loaders/text-loader.js", import.meta.url));
const dataLoaderPath = fileURLToPath(new URL("./loaders/data-loader.js", import.meta.url));
const wasmLoaderPath = fileURLToPath(new URL("./loaders/wasm-loader.js", import.meta.url));
const nodeProtocolLoaderPath = fileURLToPath(
  new URL("./loaders/node-protocol-loader.js", import.meta.url),
);
const wasmExternalPrefix = "__CLOUDFLARE_WASM_MODULE__/";
const mainEntryName = "worker";

export const RspackBundleLive = Layer.effect(
  Bundle,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const makeConfig = Effect.fn(function* (options: CloudflareOptions) {
      const canonicalProjectRoot = yield* fs
        .realPath(options.projectRoot)
        .pipe(Effect.catch(() => Effect.succeed(options.projectRoot)));
      const projectRoots = Array.from(
        new Set([normalizeResourcePath(options.projectRoot), normalizeResourcePath(canonicalProjectRoot)]),
      );
      const modules = yield* scanModuleAssets({
        options,
        fs,
        path,
      }).pipe(Effect.mapError(mapRspackError));
      const entry = yield* collectAdditionalEntries({
        options,
        fs,
        path,
        mainEntryName,
      }).pipe(Effect.mapError(mapRspackError));

      const nodeCompatEnabled = hasNodejsCompat(options.compatibilityFlags);

      const unenv = nodeCompatEnabled
        ? yield* Effect.promise(() =>
            resolveUnenv({
              compatibilityDate: options.compatibilityDate,
              compatibilityFlags: options.compatibilityFlags,
            }),
          )
        : undefined;

      const provideOptions: ProvidePluginOptions | undefined = unenv
        ? Object.fromEntries(
            Object.entries(unenv.inject).map(([name, value]) => [
              name,
              typeof value === "string" ? value : [String(value[0]), String(value[1])],
            ]),
          )
        : undefined;
      const alias = unenv
        ? Object.fromEntries(
            Object.entries(unenv.alias).map(([key, value]) => [
              key,
              resolveRspackAliasPath(value.resolvedPath),
            ]),
          )
        : {};
      const nodeProtocolUse = nodeCompatEnabled
        ? [
            {
              loader: nodeProtocolLoaderPath,
              options: {
                alias,
              },
            },
          ]
        : [];
      const scriptLoaders = (swcOptions: Record<string, unknown>) =>
        [
          {
            loader: "builtin:swc-loader",
            options: swcOptions,
          },
          ...nodeProtocolUse,
        ];

      const config: RspackOptions = {
        context: options.projectRoot,
        mode: "none",
        target: "webworker",
        entry,
        output: {
          path: options.outputDir,
          filename: "[name].js",
          chunkFilename: "[name]-[contenthash].js",
          clean: true,
          module: options.format !== "service-worker",
          library: options.format !== "service-worker" ? { type: "module" } : undefined,
          iife: options.format === "service-worker",
          chunkFormat: options.format !== "service-worker" ? "module" : "array-push",
          chunkLoading: options.format !== "service-worker" ? "import" : "import-scripts",
        },
        experiments: {
          outputModule: options.format !== "service-worker",
          incremental: "safe",
        },
        devtool: "source-map",
        stats: "errors-warnings",
        externalsType: options.format !== "service-worker" ? "module" : "var",
        externals: [
          ({ request }, callback) => {
            if (!request) {
              return callback();
            }

            if (request === "__STATIC_CONTENT_MANIFEST") {
              return callback(undefined, request);
            }

            if (request.startsWith(wasmExternalPrefix)) {
              return callback(undefined, `./${request.slice(wasmExternalPrefix.length)}`);
            }

            if (request.startsWith("cloudflare:")) {
              return callback(undefined, request);
            }

            if (!nodeCompatEnabled && request.startsWith("node:")) {
              return callback(undefined, request);
            }

            if (options.external?.includes(request)) {
              return callback(undefined, request);
            }

            return callback();
          },
        ],
        resolve: {
          alias,
          conditionNames: ["workerd", "worker", "browser", "import", "default"],
          mainFields: ["browser", "module", "main"],
          extensionAlias: {
            ".js": [".ts", ".tsx", ".js", ".jsx"],
            ".mjs": [".mts", ".mjs"],
            ".cjs": [".cts", ".cjs"],
          },
          extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
          tsConfig: options.tsconfig
            ? {
                configFile: path.resolve(options.projectRoot, options.tsconfig),
              }
            : undefined,
        },
        module: {
          rules: [
            {
              test: /\.[cm]?tsx?$/i,
              resource: (resource: string) => isProjectSource(resource, projectRoots),
              use: scriptLoaders({
                jsc: {
                  parser: {
                    syntax: "typescript",
                    tsx: true,
                  },
                  transform: {
                    react: {
                      runtime: "classic",
                      pragma: "h",
                      pragmaFrag: "Fragment",
                    },
                  },
                },
              }),
              type: "javascript/auto",
            },
            {
              test: /\.[cm]?jsx?$/i,
              resource: (resource: string) => isProjectSource(resource, projectRoots),
              use: scriptLoaders({
                jsc: {
                  parser: {
                    syntax: "ecmascript",
                    jsx: true,
                  },
                  transform: {
                    react: {
                      runtime: "classic",
                      pragma: "h",
                      pragmaFrag: "Fragment",
                    },
                  },
                },
              }),
              type: "javascript/auto",
            },
            ...(nodeProtocolUse.length > 0
              ? [
                  {
                    test: /\.[cm]?jsx?$/i,
                    resource: (resource: string) => !isProjectSource(resource, projectRoots),
                    use: nodeProtocolUse,
                    type: "javascript/auto",
                  },
                ]
              : []),
            ...createModuleRules(options, path),
          ],
        },
        optimization: {
          minimize: options.minify ?? false,
          mangleExports: options.minify ? "deterministic" : false,
        },
        plugins: [
          new DefinePlugin(deriveDefines(options)),
          ...(provideOptions
            ? [
                new ProvidePlugin(provideOptions),
              ]
            : []),
          createNavigatorUserAgentCommentStripPlugin(options),
        ],
      };

      return {
        config,
        modules,
      };
    });

    return Bundle.of({
      build: Effect.fn(function* (options) {
        const { config, modules } = yield* makeConfig(options);
        const compiler = rspack(config) as Compiler;
        try {
          const stats = yield* runCompiler(compiler);
          return yield* mapStatsToResult({
            options,
            stats,
            path,
            fs,
            modules,
          });
        } finally {
          yield* closeCompiler(compiler);
        }
      }),
      watch: (options) =>
        Stream.callback<Result.Result<BundleResult, BundleError>, never>((queue) =>
          Effect.gen(function* () {
            const { config, modules } = yield* makeConfig(options);
            const compiler = rspack(config) as Compiler;

            const watching = compiler.watch({ aggregateTimeout: 50 }, async (error, stats) => {
              if (error) {
                Queue.offerUnsafe(queue, Result.fail(mapRspackError(error)));
                return;
              }

              if (!stats) {
                Queue.offerUnsafe(
                  queue,
                  Result.fail(
                    new BuildError({
                      message: "Rspack watch callback returned no stats.",
                      errors: [],
                      warnings: [],
                    }),
                  ),
                );
                return;
              }

              try {
                const result = await Effect.runPromise(
                  mapStatsToResult({
                    options,
                    stats,
                    path,
                    fs,
                    modules,
                  }),
                );
                Queue.offerUnsafe(queue, Result.succeed(result));
              } catch (cause) {
                Queue.offerUnsafe(
                  queue,
                  Result.fail(cause instanceof BuildError ? cause : mapRspackError(cause)),
                );
              }
            });

            return yield* Effect.addFinalizer(() => closeWatching(watching).pipe(Effect.ignore));
          }).pipe(
            Effect.catch((error) =>
              Queue.offer(
                queue,
                Result.fail(error instanceof BuildError ? error : mapRspackError(error)),
              ).pipe(Effect.asVoid),
            ),
          ),
        ),
    });
  }),
);

const runCompiler = (compiler: Compiler) =>
  Effect.tryPromise({
    try: () =>
      new Promise<Stats>((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error) {
            reject(error);
            return;
          }
          if (!stats) {
            reject(
              new BuildError({
                message: "Rspack compilation returned no stats.",
                errors: [],
                warnings: [],
              }),
            );
            return;
          }
          resolve(stats);
        });
      }),
    catch: mapRspackError,
  });

const closeCompiler = (compiler: Compiler) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        compiler.close(() => resolve());
      }),
  );

const closeWatching = (watching: { close(callback: (...args: Array<any>) => void): void }) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        watching.close(() => resolve());
      }),
  );

const mapStatsToResult = Effect.fn(function* ({
  options,
  stats,
  path,
  fs,
  modules,
}: {
  readonly options: CloudflareOptions;
  readonly stats: Stats;
  readonly path: Path.Path;
  readonly fs: FileSystem.FileSystem;
  readonly modules: ReadonlyArray<Module>;
}) {
  const json = stats.toJson({
    entrypoints: true,
    assets: true,
    errors: true,
    warnings: true,
  });

  if (stats.hasErrors()) {
    return yield* new BuildError({
      message: `Build failed with ${(json.errors ?? []).length} error(s) and ${(json.warnings ?? []).length} warning(s)`,
      errors: mapStatsMessages(json.errors),
      warnings: mapStatsMessages(json.warnings),
    });
  }

  const mainAsset = json.entrypoints?.[mainEntryName]?.assets?.find((asset) =>
    asset.name.endsWith(".js") || asset.name.endsWith(".mjs") || asset.name.endsWith(".cjs"),
  );
  if (!mainAsset) {
    return yield* new BuildError({
      message: `Build failed to produce an entry asset for "${mainEntryName}".`,
      errors: [],
      warnings: mapStatsMessages(json.warnings),
    });
  }

  const main = path.resolve(options.outputDir, mainAsset.name);
  const outputModules = modules.map((module) => ({
    ...module,
    path: path.resolve(path.dirname(main), module.name),
  }));
  if (outputModules.length > 0) {
    yield* writeAdditionalModules(outputModules, path.dirname(main)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  }
  const emittedModules = yield* readEmittedJavaScriptModules({
    fs,
    path,
    outputDir: options.outputDir,
    main,
  }).pipe(Effect.mapError(mapRspackError));

  return {
    main,
    modules: [...emittedModules, ...outputModules],
    type: options.format === "service-worker" ? "commonjs" : "esm",
    outputDir: options.outputDir,
  } satisfies BundleResult;
});

const scanModuleAssets = Effect.fn(function* ({
  options,
  fs,
  path,
}: {
  readonly options: CloudflareOptions;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const collector = new ModuleCollectorCore({
    rules: options.rules,
    preserveFileNames: options.preserveFileNames,
  });
  const modules: Array<Module> = [];

  const visit: (directory: string) => Effect.Effect<void, unknown> = (directory) =>
    fs.readDirectory(directory).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(
          names,
          (name) => {
            if (name === "node_modules" || name.startsWith(".")) {
              return Effect.void;
            }

            const filePath = path.join(directory, name);
            return fs.stat(filePath).pipe(
              Effect.flatMap((stat) => {
                if (stat.type === "Directory") {
                  return visit(filePath);
                }

                const relativePath = `./${path
                  .relative(options.projectRoot, filePath)
                  .replaceAll("\\", "/")}`;
                const moduleType = collector.match(relativePath);
                if (moduleType === null) {
                  return Effect.void;
                }

                return Effect.promise(() => collector.collect(filePath, relativePath, moduleType)).pipe(
                  Effect.map((module) => {
                    modules.push({
                      ...module,
                      path: filePath,
                    });
                  }),
                );
              }),
            );
          },
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

  yield* visit(options.projectRoot);
  return modules;
});

const createModuleRules = (options: CloudflareOptions, path: Path.Path) =>
  parseRules(options.rules).flatMap((rule) => {
    if (rule.type === "ESModule" || rule.type === "CommonJS") {
      return [];
    }

    const loader =
      rule.type === "CompiledWasm"
        ? {
            loader: wasmLoaderPath,
            options: {
              preserveFileNames: options.preserveFileNames ?? false,
            },
          }
        : rule.type === "Text"
          ? { loader: textLoaderPath }
          : { loader: dataLoaderPath };

    return rule.globs.map((glob) => {
      const filter = globToRegExp(glob);
      return {
        resource: (resource: string) => {
          const relativePath = `./${path.relative(options.projectRoot, resource).replaceAll("\\", "/")}`;
          return filter.test(relativePath);
        },
        type: "javascript/auto" as const,
        use: [loader],
      };
    });
  });

const createNavigatorUserAgentCommentStripPlugin = (options: CloudflareOptions): Plugin => ({
  apply(compiler: Compiler) {
    if (!options.compatibilityDate || options.compatibilityDate < "2022-03-21") {
      return;
    }

    compiler.hooks.thisCompilation.tap("distilled-strip-navigator-user-agent-comments", (compilation: any) => {
      compilation.hooks.processAssets.tap(
        {
          name: "distilled-strip-navigator-user-agent-comments",
        },
        (assets: Record<string, any>) => {
          for (const [filename, source] of Object.entries(assets)) {
            if (!filename.endsWith(".js") && !filename.endsWith(".mjs") && !filename.endsWith(".cjs")) {
              continue;
            }

            const code = source.source().toString();
            if (!code.includes("navigator.userAgent")) {
              continue;
            }

            compilation.updateAsset(
              filename,
              new sources.RawSource(code.replaceAll("navigator.userAgent", '"Cloudflare-Workers"')),
            );
          }
        },
      );
    });
  },
});

const normalizeResourcePath = (resource: string): string => resource.replaceAll("\\", "/").replace(/\/+$/, "");

const isProjectSource = (resource: string, projectRoots: ReadonlyArray<string>): boolean => {
  const normalizedResource = normalizeResourcePath(resource);
  return projectRoots.some(
    (projectRoot) =>
      normalizedResource === projectRoot || normalizedResource.startsWith(`${projectRoot}/`),
  );
};

const resolveRspackAliasPath = (resolvedPath: string): string => {
  if (resolvedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(resolvedPath)) {
    return resolvedPath;
  }

  const candidate = resolvedPath.startsWith("node:") ? resolvedPath.slice(5) : resolvedPath;
  for (const packageName of [
    "unenv",
    "@cloudflare/unenv-preset",
  ]) {
    try {
      const packageRoot = nodePath.dirname(require.resolve(`${packageName}/package.json`));
      const runtimeFile = nodePath.join(packageRoot, "dist", "runtime", "node", `${candidate}.mjs`);
      if (existsSync(runtimeFile)) {
        return runtimeFile;
      }
    } catch {
      continue;
    }
  }

  return resolvedPath;
};

const mapStatsMessages = (messages: ReadonlyArray<any> | undefined) =>
  (messages ?? []).map((message, index) => ({
    id: message.code ? String(message.code) : `RSPACK_${index}`,
    pluginName: message.moduleName ? String(message.moduleName) : "",
    text: message.message ? String(message.message) : String(message),
    location: null,
    notes: [],
    detail: message,
  }));

const mapRspackError = (cause: unknown): BuildError =>
  new BuildError({
    message: cause instanceof Error ? cause.message : String(cause),
    errors: [],
    warnings: [],
  });
