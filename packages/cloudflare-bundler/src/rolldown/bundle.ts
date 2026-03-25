import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { readFile } from "node:fs/promises";
import type {
  InputOptions,
  OutputAsset,
  OutputChunk,
  OutputOptions,
  RolldownOutput,
} from "rolldown";
import { rolldown } from "rolldown";
import * as Bundler from "../Bundler.js";
import type { Diagnostic, DiagnosticLocation } from "../Error.js";
import { BuildError, SystemError, ValidationError } from "../Error.js";
import { hash } from "../hash.js";
import type { Input } from "../Input.js";
import { Module } from "../Module.js";
import { Output } from "../Output.js";
import { isSourceMapAsset } from "../plugins/additional-modules.js";
import { createPluginChain } from "../plugins/index.js";

const hasNodejsCompat = (flags?: ReadonlyArray<string>) =>
  flags?.some((flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2") ?? false;

const toLocation = (value: unknown): DiagnosticLocation | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const line = typeof record.line === "number" ? record.line : undefined;
  const column = typeof record.column === "number" ? record.column : undefined;
  const file = typeof record.file === "string" ? record.file : undefined;
  if (line === undefined || column === undefined || !file) {
    return undefined;
  }
  return { file, line, column };
};

const toDiagnostic = (value: unknown, severity: "error" | "warning"): Diagnostic => {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  return {
    message:
      typeof record?.message === "string"
        ? record.message
        : value instanceof Error
          ? value.message
          : String(value),
    plugin: typeof record?.plugin === "string" ? record.plugin : undefined,
    severity,
    location: toLocation(record?.loc),
  };
};

const toBuildError = (cause: unknown): BuildError =>
  cause instanceof BuildError
    ? cause
    : new BuildError({
        message: cause instanceof Error ? cause.message : String(cause),
        diagnostics: [
          ...(Array.isArray((cause as { errors?: ReadonlyArray<unknown> } | undefined)?.errors)
            ? (cause as { errors: ReadonlyArray<unknown> }).errors.map((error) =>
                toDiagnostic(error, "error"),
              )
            : [toDiagnostic(cause, "error")]),
          ...(Array.isArray((cause as { warnings?: ReadonlyArray<unknown> } | undefined)?.warnings)
            ? (cause as { warnings: ReadonlyArray<unknown> }).warnings.map((warning) =>
                toDiagnostic(warning, "warning"),
              )
            : []),
        ],
      });

const deriveDefines = (options: Input) => {
  const compatDate = options.cloudflare?.compatibilityDate;
  const nodejsCompat = hasNodejsCompat(options.cloudflare?.compatibilityFlags);

  return {
    "process.env.NODE_ENV": '"production"',
    "global.process.env.NODE_ENV": '"production"',
    "globalThis.process.env.NODE_ENV": '"production"',
    ...(nodejsCompat
      ? {}
      : {
          "process.env": "{}",
          "global.process.env": "{}",
          "globalThis.process.env": "{}",
        }),
    ...(compatDate && compatDate >= "2022-03-21"
      ? {
          "navigator.userAgent": '"Cloudflare-Workers"',
        }
      : {}),
    ...options.define,
  };
};

const toBuffer = (source: string | Uint8Array) =>
  typeof source === "string" ? Buffer.from(source) : Buffer.from(source);

const createChunkModule = (chunk: OutputChunk, content: string | Uint8Array) =>
  new Module({
    name: chunk.fileName,
    content: toBuffer(content),
    hash: hash(toBuffer(content)),
    type: "ESModule",
  });

const createSourceMapModule = (asset: OutputAsset) => {
  const content = toBuffer(asset.source);
  return new Module({
    name: asset.fileName,
    content,
    hash: hash(content),
    type: "SourceMap",
  });
};

const createInputOptions = Effect.fn("createInputOptions")(function* (
  options: Input,
  path: Path.Path,
) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const main = path.resolve(rootDir, options.main);
  const outDir = path.resolve(rootDir, options.outDir ?? "dist");
  const pluginChain = yield* Effect.tryPromise({
    try: () =>
      createPluginChain({
        ...options,
        main,
        rootDir,
        outDir,
      }),
    catch: (cause) =>
      new SystemError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

  return {
    rootDir,
    outDir,
    pluginChain,
    inputOptions: {
      input: pluginChain.entryId,
      cwd: rootDir,
      platform: "neutral",
      plugins: [...pluginChain.plugins],
      external: (id) => options.external?.includes(id) ?? false,
      resolve: {
        conditionNames: ["workerd", "worker", "browser", "module", "import", "default"],
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      },
      moduleTypes: {
        ".js": "jsx",
        ".mjs": "jsx",
        ".cjs": "jsx",
      },
      transform: {
        define: deriveDefines(options),
      },
      tsconfig: options.tsconfig ? path.resolve(rootDir, options.tsconfig) : true,
    } satisfies InputOptions,
    outputOptions: {
      dir: outDir,
      format: "esm",
      sourcemap: options.sourcemap ?? true,
      minify: options.minify ?? false,
      keepNames: options.keepNames ?? true,
      entryFileNames: "[name].js",
      chunkFileNames: "[name]-[hash].js",
      assetFileNames: "assets/[name]-[hash][extname]",
    } satisfies OutputOptions,
  };
});

const collectChunkAndSourceMapModules = async (output: RolldownOutput, directory: string) => {
  const modules = await Promise.all(
    output.output.flatMap((item) => {
      if (item.type === "chunk") {
        return [
          readFile(`${directory}/${item.fileName}`).then((content) =>
            createChunkModule(item, content),
          ),
        ];
      }
      if (isSourceMapAsset(item)) {
        return [Promise.resolve(createSourceMapModule(item))];
      }
      return [];
    }),
  );

  const byName = new Map(modules.map((module) => [module.name, module] as const));
  return Array.from(byName.values());
};

export const RolldownBundler = Layer.effect(
  Bundler.Bundler,
  Effect.gen(function* () {
    const path = yield* Path.Path;

    return Bundler.Bundler.of({
      build: Effect.fn("RolldownBundler.build")(function* (options) {
        const { inputOptions, outputOptions, outDir, pluginChain } = yield* createInputOptions(
          options,
          path,
        );

        const bundle = yield* Effect.tryPromise({
          try: () => rolldown(inputOptions),
          catch: toBuildError,
        });

        try {
          const result = yield* Effect.tryPromise({
            try: () => bundle.write(outputOptions),
            catch: toBuildError,
          });
          const additionalModules = yield* Effect.tryPromise({
            try: () => pluginChain.rewriteAdditionalModules(result, outDir),
            catch: (cause) =>
              new SystemError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });
          const bundledModules = yield* Effect.tryPromise({
            try: () => collectChunkAndSourceMapModules(result, outDir),
            catch: (cause) =>
              new SystemError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });

          const entryChunk = result.output.find(
            (item): item is OutputChunk => item.type === "chunk" && item.isEntry,
          );
          if (!entryChunk) {
            return yield* new ValidationError({
              reason: "MissingEntryChunk",
              message: "Build completed without producing an entry chunk.",
            });
          }

          return new Output({
            outDir,
            main: entryChunk.fileName,
            modules: [...bundledModules, ...additionalModules],
            warnings: [...pluginChain.getWarnings()],
          });
        } finally {
          yield* Effect.promise(() => bundle.close()).pipe(Effect.ignore);
        }
      }),
    });
  }),
);
