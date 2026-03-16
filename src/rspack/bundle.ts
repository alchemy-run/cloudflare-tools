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
  type ProvidePluginOptions,
  type RspackOptions,
  type Stats,
} from "@rspack/core";
import crypto from "node:crypto";
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
  mapBuildError,
  readEmittedJavaScriptModules,
} from "../backend-utils.js";
import { deriveDefines } from "../cloudflare-defaults.js";
import { BuildError, type BundleError } from "../errors.js";
import { makeRuleFilters, parseRules } from "../module-rules.js";
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

const reactTransform = {
  runtime: "classic" as const,
  pragma: "h",
  pragmaFrag: "Fragment",
};

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
        new Set([normalizePath(options.projectRoot), normalizePath(canonicalProjectRoot)]),
      );
      const modules = yield* scanModuleAssets({ options, fs, path }).pipe(
        Effect.mapError(mapBuildError),
      );
      const entry = yield* collectAdditionalEntries({
        options,
        fs,
        path,
        mainEntryName,
      }).pipe(Effect.mapError(mapBuildError));

      const nodeCompat = hasNodejsCompat(options.compatibilityFlags);

      const unenv = nodeCompat
        ? yield* Effect.promise(() =>
            resolveUnenv({
              compatibilityDate: options.compatibilityDate,
              compatibilityFlags: options.compatibilityFlags,
            }),
          )
        : undefined;

      const alias = unenv
        ? Object.fromEntries(
            Object.entries(unenv.alias).map(([key, value]) => [
              key,
              resolveAliasPath(value.resolvedPath),
            ]),
          )
        : {};

      const nodeProtocolUse = nodeCompat
        ? [{ loader: nodeProtocolLoaderPath, options: { alias } }]
        : [];

      const scriptLoaders = (parserOptions: Record<string, unknown>) => [
        {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              target: "es2024",
              parser: parserOptions,
              transform: { react: reactTransform },
            },
          },
        },
        ...nodeProtocolUse,
      ];

      const isESM = options.format !== "service-worker";

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
          module: isESM,
          library: isESM ? { type: "module" } : undefined,
          iife: !isESM,
          chunkFormat: isESM ? "module" : "array-push",
          chunkLoading: isESM ? "import" : "import-scripts",
        },
        experiments: {
          outputModule: isESM,
          incremental: "safe",
        },
        devtool: "source-map",
        stats: "errors-warnings",
        externalsType: isESM ? "module" : "var",
        externals: [
          ({ request }, callback) => {
            if (!request) return callback();
            if (request === "__STATIC_CONTENT_MANIFEST") return callback(undefined, request);
            if (request.startsWith(wasmExternalPrefix))
              return callback(undefined, `./${request.slice(wasmExternalPrefix.length)}`);
            if (request.startsWith("cloudflare:")) return callback(undefined, request);
            if (!nodeCompat && request.startsWith("node:")) return callback(undefined, request);
            if (options.external?.includes(request)) return callback(undefined, request);
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
            ? { configFile: path.resolve(options.projectRoot, options.tsconfig) }
            : undefined,
        },
        module: {
          rules: [
            {
              test: /\.[cm]?tsx?$/i,
              resource: (r: string) => isProjectSource(r, projectRoots),
              use: scriptLoaders({ syntax: "typescript", tsx: true }),
              type: "javascript/auto",
            },
            {
              test: /\.[cm]?jsx?$/i,
              resource: (r: string) => isProjectSource(r, projectRoots),
              use: scriptLoaders({ syntax: "ecmascript", jsx: true }),
              type: "javascript/auto",
            },
            ...(nodeProtocolUse.length > 0
              ? [
                  {
                    test: /\.[cm]?jsx?$/i,
                    resource: (r: string) => !isProjectSource(r, projectRoots),
                    use: nodeProtocolUse,
                    type: "javascript/auto" as const,
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
          ...(unenv
            ? [
                new ProvidePlugin(
                  Object.fromEntries(
                    Object.entries(unenv.inject).map(([name, value]) => [
                      name,
                      typeof value === "string"
                        ? value
                        : [String(value[0]), String(value[1])],
                    ]),
                  ) as ProvidePluginOptions,
                ),
              ]
            : []),
          navigatorUserAgentPlugin(options),
        ],
      };

      return { config, modules };
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
        const { config, modules } = yield* makeConfig(options);
        const compiler = rspack(config) as Compiler;
        try {
          const stats = yield* runCompiler(compiler);
          return yield* mapStatsToResult({ options, stats, modules });
        } finally {
          yield* promisifyClose(compiler);
        }
      }),
      watch: (options) =>
        Stream.callback<Result.Result<BundleResult, BundleError>, never>((queue) =>
          Effect.gen(function* () {
            const { config, modules } = yield* makeConfig(options);
            const compiler = rspack(config) as Compiler;

            const watching = compiler.watch({ aggregateTimeout: 50 }, async (error, stats) => {
              if (error) {
                Queue.offerUnsafe(queue, Result.fail(mapBuildError(error)));
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
                  mapStatsToResult({ options, stats, modules }),
                );
                Queue.offerUnsafe(queue, Result.succeed(result));
              } catch (cause) {
                Queue.offerUnsafe(queue, Result.fail(mapBuildError(cause)));
              }
            });

            return yield* Effect.addFinalizer(() => promisifyClose(watching).pipe(Effect.ignore));
          }).pipe(
            Effect.catch((error) =>
              Queue.offer(queue, Result.fail(mapBuildError(error))).pipe(Effect.asVoid),
            ),
          ),
        ),
    });

    function mapStatsToResult({
      options,
      stats,
      modules,
    }: {
      readonly options: CloudflareOptions;
      readonly stats: Stats;
      readonly modules: ReadonlyArray<Module>;
    }) {
      return Effect.gen(function* () {
        const json = stats.toJson({
          entrypoints: true,
          assets: true,
          errors: true,
          warnings: true,
        });

        if (stats.hasErrors()) {
          return yield* new BuildError({
            message: `Build failed with ${(json.errors ?? []).length} error(s) and ${(json.warnings ?? []).length} warning(s)`,
            errors: (json.errors ?? []).map((m, i) => ({
              id: m.code ? String(m.code) : `RSPACK_${i}`,
              pluginName: m.moduleName ? String(m.moduleName) : "",
              text: m.message ? String(m.message) : String(m),
              location: null,
              notes: [],
              detail: m,
            })),
            warnings: [],
          });
        }

        const mainAsset = json.entrypoints?.[mainEntryName]?.assets?.find(
          (a) => a.name.endsWith(".js") || a.name.endsWith(".mjs") || a.name.endsWith(".cjs"),
        );
        if (!mainAsset) {
          return yield* new BuildError({
            message: `Build failed to produce an entry asset for "${mainEntryName}".`,
            errors: [],
            warnings: [],
          });
        }

        const main = path.resolve(options.outputDir, mainAsset.name);
        const outputModules = modules.map((m) => ({
          ...m,
          path: path.resolve(path.dirname(main), m.name),
        }));
        yield* writeCopiedModules(outputModules, path.dirname(main));
        const emittedModules = yield* readEmittedJavaScriptModules({
          fs,
          path,
          outputDir: options.outputDir,
          main,
        }).pipe(Effect.mapError(mapBuildError));

        return {
          main,
          modules: [...emittedModules, ...outputModules],
          type: options.format === "service-worker" ? "commonjs" : "esm",
          outputDir: options.outputDir,
        } satisfies BundleResult;
      });
    }
  }),
);

const runCompiler = (compiler: Compiler) =>
  Effect.tryPromise({
    try: () =>
      new Promise<Stats>((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error) return reject(error);
          if (!stats)
            return reject(
              new BuildError({ message: "Rspack compilation returned no stats.", errors: [], warnings: [] }),
            );
          resolve(stats);
        });
      }),
    catch: mapBuildError,
  });

const promisifyClose = (closeable: { close(cb: (...args: Array<any>) => void): void }) =>
  Effect.promise(() => new Promise<void>((resolve) => closeable.close(() => resolve())));

const scanModuleAssets = Effect.fn(function* ({
  options,
  fs,
  path,
}: {
  readonly options: CloudflareOptions;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const ruleFilters = makeRuleFilters(parseRules(options.rules));
  const preserveFileNames = options.preserveFileNames ?? false;
  const modules: Array<Module> = [];

  const visit: (directory: string) => Effect.Effect<void, unknown> = (directory) =>
    fs.readDirectory(directory).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(
          names,
          (name) => {
            if (name === "node_modules" || name.startsWith(".")) return Effect.void;
            const filePath = path.join(directory, name);
            return fs.stat(filePath).pipe(
              Effect.flatMap((stat) => {
                if (stat.type === "Directory") return visit(filePath);
                const relativePath = `./${path.relative(options.projectRoot, filePath).replaceAll("\\", "/")}`;
                const matched = ruleFilters.find(({ filters }) =>
                  filters.some((f) => f.test(relativePath)),
                );
                if (!matched || matched.rule.type === "ESModule" || matched.rule.type === "CommonJS") {
                  return Effect.void;
                }
                return fs.readFile(filePath).pipe(
                  Effect.map((content) => {
                    const buf = Buffer.from(content);
                    const hash = crypto.createHash("sha1").update(buf).digest("hex");
                    const fileName = preserveFileNames
                      ? nodePath.basename(relativePath)
                      : `${hash}-${nodePath.basename(relativePath)}`;
                    modules.push({ name: fileName, path: filePath, content: buf, type: matched.rule.type });
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
    if (rule.type === "ESModule" || rule.type === "CommonJS") return [];
    const loader =
      rule.type === "CompiledWasm"
        ? { loader: wasmLoaderPath, options: { preserveFileNames: options.preserveFileNames ?? false } }
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

const normalizePath = (p: string): string => p.replaceAll("\\", "/").replace(/\/+$/, "");

const isProjectSource = (resource: string, projectRoots: ReadonlyArray<string>): boolean => {
  const normalized = normalizePath(resource);
  return projectRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
};

const navigatorUserAgentPlugin = (options: CloudflareOptions) => ({
  apply(compiler: Compiler) {
    if (!options.compatibilityDate || options.compatibilityDate < "2022-03-21") return;
    compiler.hooks.thisCompilation.tap("distilled-navigator-ua", (compilation: any) => {
      compilation.hooks.processAssets.tap({ name: "distilled-navigator-ua" }, (assets: Record<string, any>) => {
        for (const [name, source] of Object.entries(assets)) {
          if (!/\.[cm]?js$/.test(name)) continue;
          const code = source.source().toString();
          if (code.includes("navigator.userAgent")) {
            compilation.updateAsset(
              name,
              new sources.RawSource(code.replaceAll("navigator.userAgent", '"Cloudflare-Workers"')),
            );
          }
        }
      });
    });
  },
});

const resolveAliasPath = (resolvedPath: string): string => {
  if (resolvedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(resolvedPath)) return resolvedPath;
  const candidate = resolvedPath.startsWith("node:") ? resolvedPath.slice(5) : resolvedPath;
  for (const pkg of ["unenv", "@cloudflare/unenv-preset"]) {
    try {
      const root = nodePath.dirname(require.resolve(`${pkg}/package.json`));
      const file = nodePath.join(root, "dist", "runtime", "node", `${candidate}.mjs`);
      if (existsSync(file)) return file;
    } catch {
      continue;
    }
  }
  return resolvedPath;
};
