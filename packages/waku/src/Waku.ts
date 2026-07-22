import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@distilled.cloud/cloudflare-vite-plugin";
import * as FrameworkCore from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import type * as ViteModule from "vite";
import type { Config as WakuConfig } from "waku/config";
import type * as WakuInternals from "waku/internals";
import type * as WakuVitePlugins from "waku/vite-plugins";

type WakuInternalsModule = typeof WakuInternals;
type WakuVitePluginsModule = typeof WakuVitePlugins;
type ResolvedWakuConfig = ReturnType<WakuInternalsModule["unstable_resolveConfig"]>;

/**
 * Waku's rsc-environment worker entry, relative to the installed `waku`
 * package directory. Its default export is the adapter's `ExportedHandler`
 * (the same module waku wires as the rsc env's `index` input). The deep path
 * is not in waku's exports map, so it is joined onto the resolved package
 * directory.
 *
 * Passing it as the plugin `main` is mandatory: waku's rsc environment
 * declares two rolldown inputs (`index` + `build`) while the dev plugin
 * asserts exactly one entry.
 */
export const WAKU_SERVER_ENTRY_PATH = "dist/lib/vite-entries/entry.server.js";

/**
 * The server module that must become `serverModules[0]`: waku's own `index`
 * input of the rsc environment (`dist/server/index.js`), whose default export
 * is the adapter's `ExportedHandler`. The entry environment emits multiple
 * entry chunks (`index`, `build`, and the wrapped worker entry), so entry
 * selection is pinned to this name.
 */
export const WAKU_SERVER_ENTRY_MODULE = NodePath.join("server", "index.js");

/**
 * Options for the Waku `Framework` integration. Follows the e2e harness
 * convention: `vite` carries the cloudflare worker configuration
 * (compatibility date/flags, worker name/bindings/assets).
 */
export interface WakuFrameworkOptions {
  /**
   * Cloudflare plugin options (worker name, bindings, assets behavior,
   * compatibility date/flags). `main` and `viteEnvironments` are pinned to
   * waku's topology and cannot be overridden.
   */
  readonly vite?: CloudflareVitePluginOptions | undefined;
  /**
   * Extra waku config merged into the in-memory `resolveConfig` input
   * (`srcDir`, `distDir`, `vite`, ...). `unstable_adapter` defaults to this
   * package's wrangler-free cloudflare adapter fork.
   */
  readonly waku?: WakuConfig | undefined;
  /** Project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
  /**
   * Default dev-server port, used when `dev` is called without an explicit
   * port (e.g. the e2e harness's Playwright dev fixture). Non-strict: if the
   * port is taken, vite falls back to the next free one. A port passed to
   * `dev` directly (`e2e dev --port N`) is strict and takes precedence.
   */
  readonly port?: number | undefined;
}

/** Inputs for {@link makeWakuConfigInput} (exported for testing). */
export interface WakuConfigInputs {
  /** Absolute path of the wrangler-free cloudflare adapter module. */
  readonly adapterPath: string;
  /** Directory of the project's installed `waku` package. */
  readonly wakuDirectory: string;
  /** Cloudflare plugin options (harness convention: `options.vite`). */
  readonly pluginOptions?: CloudflareVitePluginOptions | undefined;
  /** User waku config merged in (its `vite` config is preserved). */
  readonly userConfig?: WakuConfig | undefined;
  /**
   * Whether to inject the cloudflare vite plugin into `vite.plugins`. The SSG
   * preview server omits it (Node-rendered SSG — upstream-parity fallback).
   * @default true
   */
  readonly cloudflarePlugin?: boolean | undefined;
}

/**
 * The cloudflare plugin options for a waku project: user options with `main`
 * pinned to waku's rsc worker entry and the rsc/ssr environment topology.
 */
export const makeWakuPluginOptions = (
  inputs: Pick<WakuConfigInputs, "wakuDirectory" | "pluginOptions">,
): CloudflareVitePluginOptions => ({
  ...inputs.pluginOptions,
  main: NodePath.join(inputs.wakuDirectory, WAKU_SERVER_ENTRY_PATH),
  viteEnvironments: { entry: "rsc", children: ["ssr"] },
});

const mergeWorkerEnvironment = (
  user: ViteModule.EnvironmentOptions | undefined,
  optimizeDepsInclude: Array<string>,
): ViteModule.EnvironmentOptions => ({
  ...user,
  optimizeDeps: {
    ...user?.optimizeDeps,
    include: [...optimizeDepsInclude, ...(user?.optimizeDeps?.include ?? [])],
  },
  build: {
    ...user?.build,
    rolldownOptions: {
      platform: "neutral",
      ...user?.build?.rolldownOptions,
    },
  },
});

/**
 * Build the in-memory waku `Config` (the input to waku's
 * `unstable_resolveConfig`) — the whole replacement for `waku.config.ts` and
 * `wrangler.jsonc`:
 *
 * - `unstable_adapter` defaults to this package's wrangler-free adapter fork.
 *   Leaving it unset would silently select `waku/adapters/node` (no
 *   `CLOUDFLARE` env var), which cannot run inside workerd.
 * - The cloudflare vite plugin is injected INSIDE `vite.plugins` (waku's
 *   `extraPlugins` places user plugins first, ahead of waku's own
 *   environments plugin) — the position upstream documents for
 *   `@cloudflare/vite-plugin`, and the only one where the workerd proxy
 *   middleware registers before waku's Node request bridge.
 * - `waku` and `hono` are deduped so the adapter module (which lives in this
 *   package) resolves the project's copies.
 * - rsc/ssr get the documented `optimizeDeps.include` entries and
 *   `platform: "neutral"`.
 */
export const makeWakuConfigInput = (inputs: WakuConfigInputs): WakuConfig => {
  const user = inputs.userConfig;
  const userVite = user?.vite;
  const environments = (userVite?.environments ?? {}) as Record<
    string,
    ViteModule.EnvironmentOptions | undefined
  >;
  return {
    ...user,
    unstable_adapter: user?.unstable_adapter ?? inputs.adapterPath,
    vite: {
      ...userVite,
      resolve: {
        ...userVite?.resolve,
        dedupe: [...new Set(["waku", "hono", ...(userVite?.resolve?.dedupe ?? [])])],
      },
      environments: {
        ...userVite?.environments,
        rsc: mergeWorkerEnvironment(environments.rsc, ["hono/tiny"]),
        ssr: mergeWorkerEnvironment(environments.ssr, ["waku > rsc-html-stream/server"]),
      },
      plugins: [
        ...(inputs.cloudflarePlugin === false
          ? []
          : [cloudflareVitePlugin(makeWakuPluginOptions(inputs))]),
        ...(userVite?.plugins ?? []),
      ],
    },
  };
};

/**
 * `NODE_ENV` as it was when this module first loaded. Waku's CLI sets
 * `NODE_ENV` before loading anything (waku's environmentsPlugin bakes
 * `process.env.NODE_ENV` into `define`), which we replicate — but a
 * long-lived process may run both `build` and `dev` (e.g. a playwright worker
 * driving the live and dev servers), and a plain `??=` would leak the first
 * operation's value into the second. Capturing the initial value preserves an
 * explicit user override while keeping the two operations independent.
 */
const INITIAL_NODE_ENV = process.env.NODE_ENV;

const PREVIEW_SERVER_GLOBAL = "__WAKU_START_PREVIEW_SERVER__";

/** The shape waku's `unstable_startPreviewServer` expects the global to produce. */
interface WakuPreviewServer {
  readonly baseUrl: string;
  readonly middlewares: {
    readonly use: (fn: (req: unknown, res: unknown, next: (err?: unknown) => void) => void) => void;
  };
  readonly close: () => Promise<void>;
}

/**
 * Replicates waku's `cmd-build.ts` `startPreviewServerImpl`: the SSG step of
 * `builder.buildApp()` (the adapter's `build`) calls
 * `unstable_startPreviewServer`, which throws unless this global is set. The
 * preview config omits the cloudflare plugin, so SSG renders through the
 * adapter's Node fallback middleware (upstream-parity: identical to running
 * `waku build` without `@cloudflare/vite-plugin`).
 */
const setPreviewServerGlobal = (
  vite: typeof ViteModule,
  vitePlugins: WakuVitePluginsModule,
  root: string,
  previewConfig: ResolvedWakuConfig,
): void => {
  (globalThis as Record<string, unknown>)[PREVIEW_SERVER_GLOBAL] =
    async (): Promise<WakuPreviewServer> => {
      const server = await vite.preview({
        configFile: false,
        root,
        plugins: [vitePlugins.unstable_combinedPlugins(previewConfig)],
      });
      const baseUrl = server.resolvedUrls?.local[0];
      if (!baseUrl) {
        throw new Error("Could not determine the URL of the waku SSG preview server");
      }
      return {
        baseUrl,
        middlewares: {
          use: (fn) => server.middlewares.use(fn as never),
        },
        close: () => server.close(),
      };
    };
};

const clearPreviewServerGlobal = (): void => {
  delete (globalThis as Record<string, unknown>)[PREVIEW_SERVER_GLOBAL];
};

interface ProjectModules {
  readonly vite: typeof ViteModule;
  readonly internals: WakuInternalsModule;
  readonly vitePlugins: WakuVitePluginsModule;
  readonly wakuDirectory: string;
  readonly adapterPath: string;
}

/**
 * The Waku implementation of framework-core's `Framework` service.
 *
 * - `build` replicates waku's `runBuild` (`vite.createBuilder` +
 *   `combinedPlugins` + the SSG preview-server global) and collects the
 *   `BuildOutput` with a post-`buildApp` disk re-read (waku writes
 *   `__waku_build_metadata.js` and prunes static-only chunks after the
 *   bundler finishes). The result is returned in-memory only.
 * - `dev` replicates waku's `runDev` with the cloudflare vite plugin injected
 *   inside waku's `config.vite.plugins`, so the rsc environment runs in
 *   workerd with in-memory bindings (no wrangler config anywhere).
 */
export const make = (
  options?: WakuFrameworkOptions,
): Layer.Layer<FrameworkCore.Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    FrameworkCore.Framework,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const fail = (message: string) => (cause: unknown) =>
        new FrameworkCore.FrameworkError({ framework: "waku", message, cause });

      const resolveRoot = (override: string | undefined) =>
        Effect.sync(() => override ?? options?.root ?? process.cwd());

      const loadProject: (
        root: string,
      ) => Effect.Effect<ProjectModules, FrameworkCore.FrameworkError> = Effect.fn(function* (
        root: string,
      ) {
        const [vite, internals, vitePlugins, wakuDirectory, adapterPath] = yield* Effect.all(
          [
            FrameworkCore.loadProjectModule<typeof ViteModule>(root, "vite").pipe(
              Effect.mapError(fail("Failed to load the project's vite")),
            ),
            FrameworkCore.loadProjectModule<WakuInternalsModule>(root, "waku/internals").pipe(
              Effect.mapError(fail("Failed to load the project's waku/internals")),
            ),
            FrameworkCore.loadProjectModule<WakuVitePluginsModule>(root, "waku/vite-plugins").pipe(
              Effect.mapError(fail("Failed to load the project's waku/vite-plugins")),
            ),
            FrameworkCore.resolveProjectPackageDirectory(root, "waku").pipe(
              Effect.mapError(fail("Failed to resolve the project's waku package directory")),
            ),
            Effect.try({
              try: () => fileURLToPath(import.meta.resolve("@distilled.cloud/waku/adapter")),
              catch: fail("Failed to resolve the @distilled.cloud/waku adapter module"),
            }),
          ],
          { concurrency: "unbounded" },
        );
        return { vite, internals, vitePlugins, wakuDirectory, adapterPath };
      });

      const makeConfig = (project: ProjectModules, cloudflarePlugin: boolean): ResolvedWakuConfig =>
        project.internals.unstable_resolveConfig(
          makeWakuConfigInput({
            adapterPath: project.adapterPath,
            wakuDirectory: project.wakuDirectory,
            pluginOptions: options?.vite,
            userConfig: options?.waku,
            cloudflarePlugin,
          }),
        );

      return FrameworkCore.Framework.of({
        build: Effect.fn(function* (buildOptions) {
          const root = yield* resolveRoot(buildOptions?.root);
          const project = yield* loadProject(root);
          // waku's CLI sets this before loading anything; waku's
          // environmentsPlugin bakes `process.env.NODE_ENV` into `define`.
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "production";
          });
          const wakuConfig = makeConfig(project, true);
          const previewConfig = makeConfig(project, false);
          const collector = yield* FrameworkCore.makeBuildOutputCollector({
            entryEnvironment: "rsc",
            selectEntry: (chunk) => chunk.name === WAKU_SERVER_ENTRY_MODULE,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          yield* Effect.tryPromise({
            try: async () => {
              const builder = await project.vite.createBuilder(
                {
                  configFile: false,
                  root,
                  plugins: [
                    project.vitePlugins.unstable_combinedPlugins(wakuConfig),
                    collector.plugin,
                  ],
                },
                null,
              );
              setPreviewServerGlobal(project.vite, project.vitePlugins, root, previewConfig);
              try {
                await builder.buildApp();
              } finally {
                clearPreviewServerGlobal();
              }
            },
            catch: fail("Failed to build"),
          });
          // Disk re-read: waku writes `__waku_build_metadata.js` and prunes
          // static-only server chunks during `buildApp` hooks, after the
          // in-memory `writeBundle` capture.
          return yield* collector
            .collect({ fromDisk: true })
            .pipe(Effect.mapError((error) => fail(error.message)(error.cause)));
        }),
        dev: Effect.fn(function* (devOptions) {
          const root = yield* resolveRoot(devOptions?.root);
          const project = yield* loadProject(root);
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "development";
          });
          const wakuConfig = makeConfig(project, true);
          const port = devOptions?.port ?? options?.port;
          const server = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                const server = await project.vite.createServer({
                  configFile: false,
                  root,
                  plugins: [project.vitePlugins.unstable_combinedPlugins(wakuConfig)],
                  ...(port !== undefined
                    ? { server: { port, strictPort: devOptions?.port !== undefined } }
                    : undefined),
                });
                return await server.listen();
              },
              catch: fail("Failed to start the waku dev server"),
            }),
            (server) => Effect.promise(async () => await server.close()),
          );
          const url = server.resolvedUrls?.local[0];
          if (url === undefined) {
            return yield* Effect.fail(
              fail("Could not determine the URL of the waku dev server")(undefined),
            );
          }
          return { url };
        }),
      });
    }),
  );
