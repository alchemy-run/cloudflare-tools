import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@distilled.cloud/cloudflare-vite-plugin";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type * as ViteModule from "vite";
import * as Runtime from "./Runtime.ts";

export class ViteError extends Data.TaggedError<"ViteError">("ViteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BuildOutput {
  clientDirectory: string | undefined;
  serverModules: Array<OutputFile> | undefined;
  externalWorkspaces: Set<string>;
}

export class Vite extends Context.Service<
  Vite,
  {
    readonly build: (
      pluginOptions?: CloudflareVitePluginOptions,
      config?: ViteModule.InlineConfig,
    ) => Effect.Effect<BuildOutput, ViteError>;
    readonly dev: (
      pluginOptions?: CloudflareVitePluginOptions,
      config?: ViteModule.InlineConfig,
    ) => Effect.Effect<{ url: string; server: ViteModule.ViteDevServer }, ViteError, Scope.Scope>;
    readonly readBuildOutput: () => Effect.Effect<BuildOutput, PlatformError>;
  }
>()("@alchemy/Vite") {}

// `@vitejs/plugin-rsc` writes these modules separately after build completes instead of emitting them as chunks.
// So, we need to detect them and read them from the file system manually.
const RSC_MANIFEST = {
  "virtual:vite-rsc/assets-manifest": "__vite_rsc_assets_manifest.js",
  "virtual:vite-rsc/environment-imports": "__vite_rsc_env_imports_manifest.js",
} as const;
type RscManifestId = keyof typeof RSC_MANIFEST;

const isRscManifestId = (id: string): id is RscManifestId => id in RSC_MANIFEST;

interface OutputFile {
  name: string;
  content: string | Uint8Array;
  hash: string;
}

export const ViteLive = Layer.effect(
  Vite,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* Runtime.Cwd;

    const load = (root: string = cwd): Effect.Effect<typeof ViteModule, ViteError> =>
      Effect.tryPromise({
        try: async () => {
          try {
            const require = createRequire(path.resolve(root, "package.json"));
            const vitePath = require.resolve("vite");
            // On Windows, absolute paths must be file:// URLs for ESM import().
            const viteUrl = pathToFileURL(vitePath);
            return await import(/* @vite-ignore */ viteUrl.href);
          } catch {
            // Fallback: try to import vite from the global node_modules (works for non-linked installs)
            // The fallback is a bare specifier and works as-is.
            return await import("vite");
          }
        },
        catch: (error) => new ViteError({ message: "Failed to load Vite", cause: error }),
      });

    const findUp = yield* cachedFunction(
      (dir: string, filenames: Array<string>): Effect.Effect<string | undefined, PlatformError> =>
        Effect.filter(
          filenames.map((filename) => path.join(dir, filename)),
          fs.exists,
          { concurrency: "unbounded" },
        ).pipe(
          Effect.flatMap(([match]) => {
            if (match) {
              return Effect.succeed(match);
            }
            const parent = path.dirname(dir);
            if (parent === dir) {
              return Effect.undefined;
            }
            return findUp(parent, filenames);
          }),
        ),
    );

    interface OutputAcc {
      distDirectory?: string;
      clientDirectory?: string;
      serverEntry?: string;
      serverModules: Map<string, Effect.Effect<OutputFile, ViteError>>;
      externalDirectories: Set<string>;
    }

    const toOutputFile = (name: string, content: string | Uint8Array) =>
      Effect.sync(() => ({
        name,
        content,
        hash: NodeCrypto.createHash("sha256").update(content).digest("hex"),
      }));

    const output = (serverEntryEnvironment: string = "ssr", acc: OutputAcc) => {
      return {
        name: "alchemy:build-output",
        sharedDuringBuild: true,
        configResolved(config) {
          acc.distDirectory ??= path.resolve(config.root, config.build.outDir);
        },
        async writeBundle(_, bundle) {
          const root = path.resolve(this.environment.config.root);
          for (const id of this.getModuleIds()) {
            if (!path.isAbsolute(id) || id.includes("node_modules") || id.startsWith(root)) {
              continue;
            }
            acc.externalDirectories.add(path.dirname(id));
          }
          if (this.environment.name === "client") {
            acc.clientDirectory = path.resolve(root, this.environment.config.build.outDir);
            return;
          }
          const prefix = path.relative(
            acc.distDirectory ?? root,
            this.environment.config.build.outDir,
          );
          for (const file of Object.values(bundle)) {
            const name = path.join(prefix, file.fileName);
            const content = file.type === "chunk" ? file.code : file.source;
            acc.serverModules.set(name, toOutputFile(name, content));
            if (file.type === "chunk") {
              if (this.environment.name === serverEntryEnvironment && file.isEntry) {
                acc.serverEntry = name;
              }
              for (const id of file.imports) {
                if (!isRscManifestId(id)) continue;
                const fileName = RSC_MANIFEST[id];
                const name = path.join(prefix, fileName);
                if (acc.serverModules.has(name)) continue;
                acc.serverModules.set(
                  name,
                  fs
                    .readFileString(
                      path.resolve(root, this.environment.config.build.outDir, fileName),
                    )
                    .pipe(
                      Effect.flatMap((content) => toOutputFile(name, content)),
                      Effect.mapError(
                        (error) => new ViteError({ message: "Failed to read file", cause: error }),
                      ),
                    ),
                );
              }
            }
          }
          if (this.environment.name === serverEntryEnvironment && !acc.serverEntry) {
            throw new Error("Server entry not found");
          }
        },
      } satisfies ViteModule.Plugin;
    };

    const collectServerModules = ({
      serverEntry,
      serverModules,
    }: OutputAcc): Effect.Effect<Array<OutputFile> | undefined, ViteError> => {
      if (!serverEntry && !serverModules.size) return Effect.undefined;
      return Effect.all(
        Array.from(serverModules.keys())
          .sort((a, b) => {
            if (a === serverEntry) return -1;
            if (b === serverEntry) return 1;
            return a.localeCompare(b);
          })
          .map((path) => serverModules.get(path)!),
        { concurrency: "unbounded" },
      );
    };

    const collectExternalWorkspaces = (
      externalDirectories: Set<string>,
    ): Effect.Effect<Set<string>, ViteError> =>
      Effect.forEach(externalDirectories, (directory) => findUp(directory, ["package.json"])).pipe(
        Effect.map(
          (paths) => new Set(paths.filter((file) => file !== undefined).map(path.dirname)),
        ),
        Effect.mapError(
          (error) =>
            new ViteError({ message: "Failed to collect external workspaces", cause: error }),
        ),
      );

    return Vite.of({
      build: Effect.fn(function* (pluginOptions, config) {
        const vite = yield* load(config?.root);
        const acc: OutputAcc = {
          serverModules: new Map(),
          externalDirectories: new Set(),
        };
        yield* Effect.tryPromise({
          try: async () => {
            const builder = await vite.createBuilder(
              {
                ...config,
                plugins: [
                  ...(config?.plugins ?? []),
                  cloudflareVitePlugin(pluginOptions),
                  output(pluginOptions?.viteEnvironments?.entry, acc),
                ],
              },
              null,
            );
            await builder.buildApp();
          },
          catch: (error) => new ViteError({ message: "Failed to build", cause: error }),
        });
        const result = yield* Effect.zipWith(
          collectServerModules(acc),
          collectExternalWorkspaces(acc.externalDirectories),
          (serverModules, externalWorkspaces) => ({
            distDirectory: acc.distDirectory,
            clientDirectory: acc.clientDirectory,
            serverModules,
            externalWorkspaces,
          }),
          { concurrent: true },
        );
        yield* fs
          .writeFileString(path.resolve(cwd, "dist/build.json"), JSON.stringify(result, null, 2))
          .pipe(
            Effect.mapError(
              (error) => new ViteError({ message: "Failed to write build.json", cause: error }),
            ),
          );
        return result;
      }),
      dev: Effect.fn(function* (pluginOptions, config) {
        const vite = yield* load(config?.root);
        const server = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const server = await vite.createServer({
                ...config,
                plugins: [...(config?.plugins ?? []), cloudflareVitePlugin(pluginOptions)],
              });
              return await server.listen();
            },
            catch: (error) =>
              new ViteError({ message: "Failed to run development server", cause: error }),
          }),
          (server) => Effect.promise(async () => await server.close()),
        );
        const url = server.resolvedUrls?.local[0];
        if (!url) {
          throw new ViteError({ message: "Could not get URL of development server" });
        }
        return {
          url,
          server,
        };
      }),
      readBuildOutput: Effect.fn(function* () {
        const content = yield* fs.readFileString(path.resolve(cwd, "dist/build.json"));
        return JSON.parse(content) as BuildOutput;
      }),
    });
  }),
);

const cachedFunction = <A extends ReadonlyArray<any>, B, E, R>(
  fn: (...args: A) => Effect.Effect<B, E, R>,
): Effect.Effect<(...args: A) => Effect.Effect<B, E, R>> =>
  Cache.make({
    lookup: (key: A) => fn(...key),
    capacity: Infinity,
    requireServicesAt: "lookup",
  }).pipe(
    Effect.map(
      (cache) =>
        (...args: A) =>
          Cache.get(cache, args),
    ),
  );
