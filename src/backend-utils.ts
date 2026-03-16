import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { CloudflareOptions } from "./bundle.js";
import { BuildError } from "./errors.js";
import type { Module } from "./module.js";

const additionalEntryExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const emittedJavaScriptExtensions = new Set([".js", ".mjs", ".cjs"]);

export const hasNodejsCompat = (flags?: ReadonlyArray<string>): boolean =>
  flags?.some((flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2") ?? false;

export const collectAdditionalEntries = Effect.fn(function* ({
  options,
  fs,
  path,
  mainEntryName,
}: {
  readonly options: CloudflareOptions;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly mainEntryName: string;
}) {
  const entryRoot = path.dirname(options.main);
  const entries: Record<string, string> = {
    [mainEntryName]: options.main,
  };

  if (!options.findAdditionalModules) {
    return entries;
  }

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

                if (!isAdditionalEntryFile(filePath, options.main, path)) {
                  return Effect.void;
                }

                const relativePath = path.relative(entryRoot, filePath);
                const entryName = relativePath
                  .slice(0, relativePath.length - path.extname(relativePath).length)
                  .replaceAll("\\", "/");
                entries[entryName] = filePath;
                return Effect.void;
              }),
            );
          },
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );

  yield* visit(entryRoot);
  return entries;
});

export const readEmittedJavaScriptModules = Effect.fn(function* ({
  fs,
  path,
  outputDir,
  main,
}: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly outputDir: string;
  readonly main: string;
}) {
  const modules: Array<Module> = [];

  const visit: (directory: string) => Effect.Effect<void, unknown> = (directory) =>
    fs.readDirectory(directory).pipe(
      Effect.flatMap((names) =>
        Effect.forEach(
          names,
          (name) => {
            const filePath = path.join(directory, name);
            return fs.stat(filePath).pipe(
              Effect.flatMap((stat) => {
                if (stat.type === "Directory") {
                  return visit(filePath);
                }

                if (!isEmittedJavaScriptFile(filePath, main, path)) {
                  return Effect.void;
                }

                return fs.readFile(filePath).pipe(
                  Effect.map((content) => {
                    modules.push({
                      name: path.relative(outputDir, filePath).replaceAll("\\", "/"),
                      path: filePath,
                      content: Buffer.from(content),
                      type: filePath.endsWith(".cjs") ? "CommonJS" : "ESModule",
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

  yield* visit(outputDir);
  return modules;
});

const isAdditionalEntryFile = (filePath: string, main: string, path: Path.Path): boolean => {
  if (filePath === main || filePath.endsWith(".d.ts")) {
    return false;
  }

  return additionalEntryExtensions.has(path.extname(filePath));
};

const isEmittedJavaScriptFile = (filePath: string, main: string, path: Path.Path): boolean =>
  filePath !== main && emittedJavaScriptExtensions.has(path.extname(filePath));

export const mapBuildError = (cause: unknown): BuildError =>
  cause instanceof BuildError
    ? cause
    : new BuildError({
        message: cause instanceof Error ? cause.message : String(cause),
        errors: [],
        warnings: [],
      });
