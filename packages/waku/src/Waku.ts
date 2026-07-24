import * as FrameworkCore from "@distilled.cloud/framework-core";
import type {
  DeployTarget,
  DeployTargetError,
  DeployTargetInput,
} from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodePath from "node:path";
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
 * Deploy targets whose bundler plugin needs an explicit entry (e.g. the
 * cloudflare target's `main`) pin it to this path: waku's rsc environment
 * declares two rolldown inputs (`index` + `build`) while such plugins assert
 * exactly one entry.
 */
export const WAKU_SERVER_ENTRY_PATH = "dist/lib/vite-entries/entry.server.js";

/**
 * The server module that must become `serverModules[0]`: waku's own `index`
 * input of the rsc environment (`dist/server/index.js`), whose default export
 * is the adapter's `ExportedHandler`. The entry environment emits multiple
 * entry chunks (`index`, `build`, and any wrapped worker entry), so entry
 * selection is pinned to this name.
 */
export const WAKU_SERVER_ENTRY_MODULE = NodePath.join("server", "index.js");

/**
 * The inputs a {@link WakuTarget} hook receives: enough to synthesize the
 * target's bundler plugins and adapter selection for one waku pass.
 */
export interface WakuTargetContext {
  /** Absolute project root. */
  readonly root: string;
  /** Directory of the project's installed `waku` package. */
  readonly wakuDirectory: string;
  /** Which waku pass the hook feeds: the production build or the HMR dev server. */
  readonly phase: "build" | "dev";
}

/**
 * The waku-specific deploy-target contract: the generic
 * `framework-core` {@link DeployTarget} seams plus the two
 * hooks a target must implement to slot into waku's toolchain:
 *
 * - `adapter` — the absolute path of the waku server-entry adapter module the
 *   in-memory config selects via `unstable_adapter`. Always required: leaving
 *   `unstable_adapter` unset makes waku silently pick `waku/adapters/node`,
 *   which cannot run on a non-Node target runtime.
 * - `vitePlugins` — vite plugins injected *first* inside waku's
 *   `config.vite.plugins` (waku's `extraPlugins` places user plugins first,
 *   ahead of waku's own environments plugin) — the position upstream
 *   documents for `@cloudflare/vite-plugin`, and the only one where a
 *   target's request-proxy middleware registers before waku's Node request
 *   bridge.
 *
 * The Cloudflare implementation ships at `@distilled.cloud/waku/cloudflare`
 * (the default). A future target (e.g. AWS) is a new module implementing the
 * same two hooks — no change to this package's orchestration.
 */
export interface WakuTarget<Config = unknown> extends DeployTarget<Config> {
  /** Absolute path of the adapter module waku's config selects via `unstable_adapter`. */
  readonly adapter: (context: WakuTargetContext) => Effect.Effect<string, DeployTargetError>;
  /** Vite plugins injected first inside waku's `vite.plugins` (dev + build). */
  readonly vitePlugins: (
    context: WakuTargetContext,
  ) => Effect.Effect<ReadonlyArray<ViteModule.PluginOption>, DeployTargetError>;
}

/**
 * Structural mirror of the e2e harness's target-scoped config carriage
 * (`Options.TargetOptions`): a plain selection object whose `cloudflare.worker`
 * carries the cloudflare target's configuration. Distinguished from a
 * {@link DeployTargetInput} structurally (it is neither a
 * string, a function, nor a `DeployTarget` value).
 */
export interface WakuHarnessTargetOptions {
  /** Which platform target drives the integration. @default "cloudflare" */
  readonly name?: string | undefined;
  readonly cloudflare?: { readonly worker?: unknown } | undefined;
}

/**
 * How the deploy target is passed to the waku integration:
 *
 * - a target value / factory / module-specifier string (a
 *   {@link DeployTargetInput}) — resolved with
 *   `resolveDeployTarget`
 * - the e2e harness's target-scoped carriage
 *   ({@link WakuHarnessTargetOptions}) — selects the default cloudflare
 *   target module and hands it `cloudflare.worker` as its config
 * - omitted — the default cloudflare target module with the deprecated
 *   `vite` alias as its config
 */
export type WakuTargetOption = DeployTargetInput<WakuTarget, unknown> | WakuHarnessTargetOptions;

/**
 * The module specifier of the default deploy target, loaded from the
 * *project's* `node_modules` when no explicit target is passed.
 */
export const DEFAULT_TARGET_SPECIFIER = "@distilled.cloud/waku/cloudflare";

/**
 * Options for the Waku `Framework` integration.
 */
export interface WakuFrameworkOptions {
  /**
   * The deploy target the build is produced for. Accepts a target value
   * (build it by importing the target module, e.g.
   * `@distilled.cloud/waku/cloudflare`, for full config type safety), a
   * `(config) => target` factory, a module specifier string, or the e2e
   * harness's target-scoped carriage. Defaults to the cloudflare target
   * module ({@link DEFAULT_TARGET_SPECIFIER}).
   */
  readonly target?: WakuTargetOption | undefined;
  /**
   * @deprecated Alias for the deploy target's configuration (the harness's
   * pre-target `vite` field, carrying the cloudflare worker configuration).
   * Prefer passing a fully-built target via {@link target}, or the harness's
   * target-scoped `target.cloudflare.worker`.
   */
  readonly vite?: unknown;
  /**
   * Extra waku config merged into the in-memory `resolveConfig` input
   * (`srcDir`, `distDir`, `vite`, ...). `unstable_adapter` defaults to the
   * deploy target's adapter module.
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

const isDeployTargetInput = (value: unknown): value is DeployTargetInput<WakuTarget, unknown> =>
  typeof value === "string" || typeof value === "function" || FrameworkCore.isDeployTarget(value);

/** The normalized `(input, config)` pair fed to `resolveDeployTarget`. */
export interface WakuTargetInputSelection {
  readonly input: DeployTargetInput<WakuTarget, unknown>;
  readonly config: unknown;
}

/**
 * Normalize {@link WakuFrameworkOptions} into the `(input, config)` pair for
 * `resolveDeployTarget`:
 *
 * - an explicit `DeployTargetInput` is used as-is, with the deprecated `vite`
 *   alias as the config a factory/specifier receives
 * - the harness carriage (or no target at all) selects the default target
 *   module with `target.cloudflare.worker ?? vite` as its config
 */
export const selectWakuTargetInput = (options?: WakuFrameworkOptions): WakuTargetInputSelection => {
  const raw = options?.target;
  if (raw !== undefined && isDeployTargetInput(raw)) {
    return { input: raw, config: options?.vite };
  }
  return {
    input: DEFAULT_TARGET_SPECIFIER,
    config: raw?.cloudflare?.worker ?? options?.vite,
  };
};

/** Inputs for {@link makeWakuConfigInput} (exported for testing). */
export interface WakuConfigInputs {
  /** Absolute path of the adapter module (the target's `adapter` hook). */
  readonly adapterPath: string;
  /**
   * Deploy-target vite plugins injected first inside `vite.plugins` (the
   * target's `vitePlugins` hook). The SSG preview config passes none — the
   * Node-rendered SSG fallback is upstream parity for a build without a
   * platform plugin.
   */
  readonly plugins?: ReadonlyArray<ViteModule.PluginOption> | undefined;
  /** User waku config merged in (its `vite` config is preserved). */
  readonly userConfig?: WakuConfig | undefined;
}

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
 * any platform config file:
 *
 * - `unstable_adapter` defaults to the deploy target's adapter module.
 *   Leaving it unset would silently select `waku/adapters/node` (no
 *   `CLOUDFLARE` env var), which cannot run on a non-Node target runtime.
 * - The target's vite plugins are injected INSIDE `vite.plugins` (waku's
 *   `extraPlugins` places user plugins first, ahead of waku's own
 *   environments plugin) — the position upstream documents for
 *   `@cloudflare/vite-plugin`, and the only one where the target's proxy
 *   middleware registers before waku's Node request bridge.
 * - `waku` and `hono` are deduped so the adapter module (which lives outside
 *   the project) resolves the project's copies.
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
      plugins: [...(inputs.plugins ?? []), ...(userVite?.plugins ?? [])],
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
 * preview config omits the deploy target's plugins, so SSG renders through
 * the adapter's Node fallback middleware (upstream-parity: identical to
 * running `waku build` without a platform vite plugin).
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
}

/**
 * The Waku implementation of framework-core's `Framework` service.
 *
 * - `build` replicates waku's `runBuild` (`vite.createBuilder` +
 *   `combinedPlugins` + the SSG preview-server global) and collects the
 *   `BuildOutput` with a post-`buildApp` disk re-read (waku writes
 *   `__waku_build_metadata.js` and prunes static-only chunks after the
 *   bundler finishes). The result is returned in-memory only, then passed
 *   through the deploy target's finishing pass (if any).
 * - `dev` replicates waku's `runDev` with the deploy target's vite plugins
 *   injected inside waku's `config.vite.plugins`, so the rsc environment runs
 *   on the target's dev runtime (workerd for cloudflare) with in-memory
 *   bindings.
 *
 * Deploy-target resolution happens per operation: platform-specific halves
 * (adapter module, bundler plugins) come exclusively from the resolved
 * {@link WakuTarget} — this module contains no platform imports.
 */
export const make = (
  options?: WakuFrameworkOptions,
): Layer.Layer<FrameworkCore.Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    FrameworkCore.Framework,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const fail = (message: string) => (cause: unknown) =>
        new FrameworkCore.FrameworkError({ framework: "waku", message, cause });

      const resolveRoot = (override: string | undefined) =>
        Effect.sync(() => override ?? options?.root ?? process.cwd());

      const resolveTarget: (
        root: string,
      ) => Effect.Effect<WakuTarget, FrameworkCore.FrameworkError> = Effect.fn(function* (
        root: string,
      ) {
        const { input, config } = selectWakuTargetInput(options);
        return yield* FrameworkCore.resolveDeployTarget<WakuTarget, unknown>(
          root,
          input,
          config,
        ).pipe(Effect.mapError(fail("Failed to resolve the deploy target")));
      });

      /** Run the target's waku hooks, validating they exist (a dynamically
       * loaded module may satisfy `DeployTarget` without the waku hooks). */
      const useTargetHooks: (
        target: WakuTarget,
        context: WakuTargetContext,
      ) => Effect.Effect<
        { adapterPath: string; plugins: ReadonlyArray<ViteModule.PluginOption> },
        FrameworkCore.FrameworkError
      > = Effect.fn(function* (target: WakuTarget, context: WakuTargetContext) {
        if (typeof target.adapter !== "function" || typeof target.vitePlugins !== "function") {
          return yield* Effect.fail(
            fail(
              `Deploy target "${target.platform}" does not implement the waku target hooks ` +
                "(adapter, vitePlugins) required to drive waku " +
                context.phase,
            )(undefined),
          );
        }
        const [adapterPath, plugins] = yield* Effect.all(
          [target.adapter(context), target.vitePlugins(context)],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(fail(`The deploy target failed preparing the waku ${context.phase}`)),
        );
        return { adapterPath, plugins };
      });

      const loadProject: (
        root: string,
      ) => Effect.Effect<ProjectModules, FrameworkCore.FrameworkError> = Effect.fn(function* (
        root: string,
      ) {
        const [vite, internals, vitePlugins, wakuDirectory] = yield* Effect.all(
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
          ],
          { concurrency: "unbounded" },
        );
        return { vite, internals, vitePlugins, wakuDirectory };
      });

      const makeConfig = (
        project: ProjectModules,
        inputs: { adapterPath: string; plugins: ReadonlyArray<ViteModule.PluginOption> },
      ): ResolvedWakuConfig =>
        project.internals.unstable_resolveConfig(
          makeWakuConfigInput({
            adapterPath: inputs.adapterPath,
            plugins: inputs.plugins,
            userConfig: options?.waku,
          }),
        );

      return FrameworkCore.Framework.of({
        build: Effect.fn(function* (buildOptions) {
          const root = yield* resolveRoot(buildOptions?.root);
          const target = yield* resolveTarget(root);
          if (target.build !== undefined) {
            // Wholesale build takeover: the target owns the entire pipeline.
            return yield* target
              .build({ root, framework: "waku" })
              .pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.mapError(fail("The deploy target's build failed")),
              );
          }
          const project = yield* loadProject(root);
          const hooks = yield* useTargetHooks(target, {
            root,
            wakuDirectory: project.wakuDirectory,
            phase: "build",
          });
          // waku's CLI sets this before loading anything; waku's
          // environmentsPlugin bakes `process.env.NODE_ENV` into `define`.
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "production";
          });
          const wakuConfig = makeConfig(project, hooks);
          const previewConfig = makeConfig(project, { ...hooks, plugins: [] });
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
          const output = yield* collector
            .collect({ fromDisk: true })
            .pipe(Effect.mapError((error) => fail(error.message)(error.cause)));
          return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
            root,
            framework: "waku",
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(fail("The deploy target's finishing pass failed")),
          );
        }),
        dev: Effect.fn(function* (devOptions) {
          const root = yield* resolveRoot(devOptions?.root);
          const target = yield* resolveTarget(root);
          const project = yield* loadProject(root);
          const hooks = yield* useTargetHooks(target, {
            root,
            wakuDirectory: project.wakuDirectory,
            phase: "dev",
          });
          yield* Effect.sync(() => {
            process.env.NODE_ENV = INITIAL_NODE_ENV ?? "development";
          });
          const wakuConfig = makeConfig(project, hooks);
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
