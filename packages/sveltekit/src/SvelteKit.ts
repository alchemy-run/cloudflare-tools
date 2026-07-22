import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as FrameworkCore from "@distilled.cloud/framework-core";
import { Framework, FrameworkError } from "@distilled.cloud/framework-core";
import type { Adapter } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "rolldown";
import type * as ViteModule from "vite";
import { makeCloudflareAdapter, type CloudflareAdapterOptions } from "./Adapter.ts";

/** The shape of the project's `@sveltejs/kit/vite` module. */
interface KitViteModule {
  readonly sveltekit: (config?: Record<string, unknown>) => Promise<ViteModule.PluginOption>;
}

export interface SvelteKitOptions {
  /**
   * Project root. Must also be the process working directory: SvelteKit
   * resolves its peers (`vite`, `@sveltejs/vite-plugin-svelte`) relative to
   * `process.cwd()`.
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /** Compatibility date for the workerd re-bundle pass. */
  readonly compatibilityDate?: string | undefined;
  /**
   * Compatibility flags for the workerd re-bundle pass. SvelteKit's server
   * graph is built for Node, so `nodejs_compat` is effectively required.
   * @default ["nodejs_compat"]
   */
  readonly compatibilityFlags?: Array<string> | undefined;
  /**
   * SvelteKit configuration passed to `sveltekit(config)` (kit v3 takes its
   * config in-memory; a `svelte.config.js` on disk is an upstream error).
   * The `adapter` field is injected by this package.
   */
  readonly kit?: Record<string, unknown> | undefined;
  /** Extra Vite inline config merged into the build/dev config. */
  readonly vite?: ViteModule.InlineConfig | undefined;
  /** Options for the wrangler-free Cloudflare adapter. */
  readonly adapter?: Omit<CloudflareAdapterOptions, "root" | "platform"> | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
        /**
         * Values exposed as `platform.env` by the dev-server stub platform.
         * Dev runs SvelteKit's own Node SSR: real Cloudflare bindings are not
         * available until the cloudflare-runtime Node-side bindings proxy
         * lands, so only in-memory values (secrets, config strings) can be
         * emulated here.
         */
        readonly env?: Record<string, unknown> | undefined;
      }
    | undefined;
}

const fail = (message: string, cause?: unknown) =>
  new FrameworkError({ framework: "sveltekit", message, cause });

/**
 * Pick the ESM target out of a package-exports entry (`"./x": "./file.js"` or
 * `"./x": { import: ..., default: ... }`, possibly nested conditions).
 */
export const resolveExportTarget = (entry: unknown): string | undefined => {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry !== null && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    for (const condition of ["import", "default"]) {
      if (condition in record) {
        const target = resolveExportTarget(record[condition]);
        if (target !== undefined) {
          return target;
        }
      }
    }
  }
  return undefined;
};

/**
 * Build the `Framework` service implementation for a SvelteKit project.
 *
 * - `build` runs kit's production build via programmatic Vite
 *   (`createBuilder().buildApp()`) with the in-memory Cloudflare adapter,
 *   then re-bundles the node-flavored `_worker.js` output for workerd with
 *   rolldown + `@distilled.cloud/cloudflare-rolldown-plugin`, producing the
 *   `BuildOutput` contract in-memory.
 * - `dev` runs kit's own Vite dev server (Node SSR, full HMR) with the stub
 *   platform from `options.dev.env`.
 */
export const make: (
  options?: SvelteKitOptions,
) => Effect.Effect<Framework["Service"], never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (options?: SvelteKitOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

    const loadVite = (root: string) =>
      FrameworkCore.loadProjectModule<typeof ViteModule>(root, "vite").pipe(
        Effect.mapError((error) => fail("Failed to load the project's Vite", error.cause)),
      );

    // `@sveltejs/kit`'s `./vite` export carries only an `import` condition, so
    // framework-core's `createRequire().resolve` dance cannot resolve it.
    // Resolve the package directory (via its universally-exported
    // `./package.json`) and walk the exports map instead.
    const loadKitViteModule = Effect.fn(function* (root: string) {
      const kitDirectory = yield* FrameworkCore.resolveProjectPackageDirectory(
        root,
        "@sveltejs/kit",
      ).pipe(
        Effect.mapError((error) =>
          fail("Failed to locate the project's @sveltejs/kit", error.cause),
        ),
      );
      const manifest = yield* fs
        .readFileString(path.join(kitDirectory, "package.json"))
        .pipe(
          Effect.mapError((error) => fail("Failed to read @sveltejs/kit's package.json", error)),
        );
      const parsed = yield* Effect.try({
        try: () => JSON.parse(manifest) as { exports?: Record<string, unknown> },
        catch: (error) => fail("Failed to parse @sveltejs/kit's package.json", error),
      });
      const target = resolveExportTarget(parsed.exports?.["./vite"]);
      if (target === undefined) {
        return yield* Effect.fail(
          fail(`The project's @sveltejs/kit (${kitDirectory}) has no "./vite" export`),
        );
      }
      return yield* Effect.tryPromise({
        try: async () =>
          (await import(
            /* @vite-ignore */ pathToFileURL(path.join(kitDirectory, target)).href
          )) as KitViteModule,
        catch: (error) => fail("Failed to load the project's @sveltejs/kit/vite", error),
      });
    });

    const loadKitPlugins = Effect.fn(function* (root: string, adapter: Adapter) {
      const kitVite = yield* loadKitViteModule(root);
      return yield* Effect.tryPromise({
        try: async () => await kitVite.sveltekit({ ...options?.kit, adapter }),
        catch: (error) => fail("Failed to construct the SvelteKit plugin", error),
      });
    });

    const viteConfig = (
      root: string,
      plugins: ViteModule.PluginOption,
    ): ViteModule.InlineConfig => ({
      root,
      configFile: false,
      ...options?.vite,
      plugins: [...(options?.vite?.plugins ?? []), plugins],
    });

    const build: Framework["Service"]["build"] = Effect.fn(function* (buildOptions) {
      const root = buildOptions?.root ?? baseRoot;
      const vite = yield* loadVite(root);
      const adapter = makeCloudflareAdapter({ ...options?.adapter, root });
      const plugins = yield* loadKitPlugins(root, adapter);

      yield* Effect.tryPromise({
        try: async () => {
          const builder = await vite.createBuilder(viteConfig(root, plugins), null);
          await builder.buildApp();
        },
        catch: (error) => fail("Failed to build", error),
      });

      const result = adapter.result.current;
      if (result === undefined) {
        return yield* Effect.fail(
          fail("The SvelteKit build completed without running the adapter"),
        );
      }

      // Re-bundle the node-flavored worker shim (and the whole
      // `.svelte-kit/output/server` graph it imports) for workerd. This
      // replaces the bundling `wrangler deploy` performs for the upstream
      // adapter.
      const distDirectory = path.resolve(root, "dist");
      const serverOutDir = path.join(distDirectory, "server");
      yield* fs
        .remove(serverOutDir, { recursive: true, force: true })
        .pipe(Effect.mapError((error) => fail("Failed to clean dist/server", error)));
      const externalDirectories = yield* Effect.tryPromise({
        try: async () => {
          const bundle = await rolldown({
            cwd: root,
            input: result.workerEntry,
            plugins: cloudflare({
              ...(options?.compatibilityDate !== undefined
                ? { compatibilityDate: options.compatibilityDate }
                : undefined),
              compatibilityFlags: options?.compatibilityFlags ?? ["nodejs_compat"],
              exports: ["default"],
            }),
          });
          try {
            const { output } = await bundle.write({
              dir: serverOutDir,
              format: "esm",
              entryFileNames: "index.js",
              chunkFileNames: "chunks/[name].js",
              sourcemap: false,
            });
            const directories = new Set<string>();
            for (const chunk of output) {
              if (chunk.type !== "chunk") continue;
              for (const id of Object.keys(chunk.modules)) {
                if (
                  !NodePath.isAbsolute(id) ||
                  id.includes("node_modules") ||
                  id.startsWith(root)
                ) {
                  continue;
                }
                directories.add(NodePath.dirname(id));
              }
            }
            return directories;
          } finally {
            await bundle.close();
          }
        },
        catch: (error) => fail("Failed to bundle the worker for workerd", error),
      });

      const wrapCollectorError = (error: FrameworkCore.CollectorError) =>
        fail(error.message, error.cause);
      const modules = yield* FrameworkCore.readServerModulesFromDisk({
        directory: serverOutDir,
        prefix: "server",
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(wrapCollectorError),
      );
      const serverModules = FrameworkCore.sortServerModules(
        modules,
        NodePath.join("server", "index.js"),
      );
      const externalWorkspaces = yield* FrameworkCore.collectExternalWorkspaces(
        externalDirectories,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(wrapCollectorError));

      const output: FrameworkCore.BuildOutput = {
        distDirectory,
        clientDirectory: result.dest,
        serverModules,
        externalWorkspaces,
      };
      return output;
    });

    const dev: Framework["Service"]["dev"] = Effect.fn(function* (devOptions) {
      const root = devOptions?.root ?? baseRoot;
      const vite = yield* loadVite(root);
      const adapter = makeCloudflareAdapter({
        ...options?.adapter,
        root,
        platform: { env: options?.dev?.env },
      });
      const plugins = yield* loadKitPlugins(root, adapter);
      const port = devOptions?.port ?? options?.dev?.port;

      const server = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const config = viteConfig(root, plugins);
            const server = await vite.createServer({
              ...config,
              server: {
                ...config.server,
                ...(port !== undefined ? { port } : undefined),
              },
            });
            return await server.listen();
          },
          catch: (error) => fail("Failed to start the dev server", error),
        }),
        (server) => Effect.promise(async () => await server.close()),
      );
      const url = server.resolvedUrls?.local[0];
      if (url === undefined) {
        return yield* Effect.fail(fail("Could not determine the dev server URL"));
      }
      return { url };
    });

    return Framework.of({ build, dev });
  });

/**
 * A `Layer` providing framework-core's `Framework` service for a SvelteKit
 * project — the fully-typed entrypoint for `e2e.config.ts` (harness form 4)
 * and alchemy's `Website.SvelteKit` composite.
 */
export const layer = (
  options?: SvelteKitOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Framework, make(options));
