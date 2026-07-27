import * as FrameworkCore from "@distilled.cloud/framework-core";
import {
  Framework,
  FrameworkError,
  type DeployTarget,
  type DeployTargetInput,
} from "@distilled.cloud/framework-core";
import type { Adapter } from "@sveltejs/kit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { pathToFileURL } from "node:url";
import type * as ViteModule from "vite";

/** The shape of the project's `@sveltejs/kit/vite` module. */
interface KitViteModule {
  readonly sveltekit: (config?: Record<string, unknown>) => Promise<ViteModule.PluginOption>;
}

/**
 * Adapter behavior a deploy target can configure without being consulted on
 * every write the adapter performs. The names mirror the knobs a static-asset
 * host exposes (fallback-page generation, the name of the binding the worker
 * shim serves assets through).
 */
export interface SvelteKitAdapterOptions {
  /**
   * Name of the static-assets binding the generated worker entry serves
   * files through.
   * @default "ASSETS"
   */
  readonly assetsBinding?: string | undefined;
  /**
   * Fallback-page behavior for requests that match no asset or route:
   * `"404-page"` writes `404.html`, `"single-page-application"` writes
   * `index.html`.
   * @default "none"
   */
  readonly notFoundHandling?: "none" | "404-page" | "single-page-application" | undefined;
  /**
   * With `notFoundHandling: "404-page"`: `"spa"` renders the app shell as the
   * fallback, `"plaintext"` writes a plain `Not Found` page.
   * @default "plaintext"
   */
  readonly fallback?: "spa" | "plaintext" | undefined;
}

/**
 * The configuration this package assembles from {@link SvelteKitOptions} and
 * hands to a deploy-target factory (see {@link SvelteKitTargetInput}). The
 * target treats it as its `DeployTarget.config`; the framework half never
 * inspects a resolved target's config.
 */
export interface SvelteKitTargetConfig {
  /** Compatibility date for the target's finishing pass. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags for the target's finishing pass. */
  readonly compatibilityFlags?: Array<string> | undefined;
  /** Adapter behavior (assets binding name, fallback generation). */
  readonly adapter?: SvelteKitAdapterOptions | undefined;
}

/** Inputs the framework passes when asking the target for a kit `Adapter`. */
export interface SvelteKitAdapterContext {
  /** Absolute project root. */
  readonly root: string;
  /**
   * Present when the adapter is constructed for the dev server: inputs for
   * the `platform` its `emulate()` must supply. Absent for production
   * builds.
   */
  readonly dev?:
    | {
        /**
         * Literal `platform.env` overrides — a same-named literal wins over
         * any target-provided platform value.
         */
        readonly env?: Record<string, unknown> | undefined;
        /**
         * Target-specific binding specs the dev platform should serve
         * (opaque to the framework half — e.g. the Cloudflare target takes
         * `cloudflare-runtime` binding hooks and proxies them onto
         * `platform.env`).
         */
        readonly bindings?: ReadonlyArray<unknown> | undefined;
      }
    | undefined;
}

/** What a target's `adapt()` must record for the framework to continue. */
export interface SvelteKitAdapterResult {
  /**
   * The static-assets directory the adapter wrote (client build +
   * prerendered pages) — becomes `BuildOutput.clientDirectory`.
   */
  readonly dest: string;
  /**
   * Absolute path of the on-disk (unbundled) server entry the adapter
   * generated — passed to the target's `finish` pass as `context.entry`.
   */
  readonly workerEntry: string;
}

/**
 * A kit `Adapter` that records where it wrote its output. Every SvelteKit
 * deploy target's adapter must populate `result.current` from `adapt()`.
 */
export interface SvelteKitAdapter extends Adapter {
  readonly result: { current?: SvelteKitAdapterResult | undefined };
  /**
   * Release resources the adapter holds for the dev server (e.g. the
   * Cloudflare target's platform-proxy workerd instance). Called by the
   * framework after the dev server closes.
   */
  readonly dispose?: (() => Promise<void>) | undefined;
}

/**
 * A deploy target for SvelteKit: the generic `DeployTarget` seams plus the
 * one framework-specific hook kit needs — the `Adapter` instance to hand to
 * `sveltekit(config)`. The target's `finish` pass receives the adapter's
 * on-disk `workerEntry` (via `context.entry`) and is responsible for turning
 * it into `BuildOutput.serverModules` for the target runtime.
 */
export interface SvelteKitTarget extends DeployTarget<SvelteKitTargetConfig> {
  /** Produce the kit `Adapter` for one build/dev invocation. */
  readonly adapter: (context: SvelteKitAdapterContext) => SvelteKitAdapter;
}

/**
 * How a deploy target is passed to this package: a `SvelteKitTarget` value, a
 * factory `(config) => SvelteKitTarget`, or a module specifier resolved from
 * the *project's* `node_modules` (default-export — or named export `target` —
 * a value or factory).
 */
export type SvelteKitTargetInput = DeployTargetInput<SvelteKitTarget, SvelteKitTargetConfig>;

/**
 * The default deploy target: this package's own Cloudflare Workers target
 * module (`src/cloudflare.ts`), loaded from the project's dependency tree.
 */
export const DEFAULT_TARGET_SPECIFIER = "@distilled.cloud/sveltekit/cloudflare";

export interface SvelteKitOptions {
  /**
   * Project root. Must also be the process working directory: SvelteKit
   * resolves its peers (`vite`, `@sveltejs/vite-plugin-svelte`) relative to
   * `process.cwd()`.
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * The deploy target the build is produced for. Accepts a target value, a
   * `(config) => target` factory, or a module specifier string.
   * @default "@distilled.cloud/sveltekit/cloudflare"
   */
  readonly target?: SvelteKitTargetInput | undefined;
  /** Compatibility date forwarded to the target via its config. */
  readonly compatibilityDate?: string | undefined;
  /**
   * Compatibility flags forwarded to the target via its config. SvelteKit's
   * server graph is built for Node, so on workerd-style targets
   * `nodejs_compat` is effectively required.
   * @default ["nodejs_compat"] (applied by the Cloudflare target)
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
  /** Adapter behavior forwarded to the target via its config. */
  readonly adapter?: SvelteKitAdapterOptions | undefined;
  readonly dev?:
    | {
        /** Default dev-server port (overridden by `FrameworkDevOptions.port`). */
        readonly port?: number | undefined;
        /**
         * Literal values exposed on the dev `platform.env`. Applied on top
         * of the values the target's dev platform serves for
         * {@link SvelteKitOptions.dev.bindings} — a same-named literal
         * always wins.
         */
        readonly env?: Record<string, unknown> | undefined;
        /**
         * Target-specific binding specs the dev platform should serve on
         * `platform.env`. Opaque to the framework half; the Cloudflare
         * target accepts `cloudflare-runtime` binding hooks (`Text.local`,
         * `KvNamespace.local`, …) and proxies them into kit's Node SSR via
         * a workerd-backed platform proxy.
         */
        readonly bindings?: ReadonlyArray<unknown> | undefined;
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
 * - `build` resolves the deploy target, then either delegates wholesale
 *   (`target.build`) or runs kit's production build via programmatic Vite
 *   (`createBuilder().buildApp()`) with the target-provided adapter and hands
 *   the adapter's on-disk worker entry to the target's `finish` pass, which
 *   produces the final `BuildOutput.serverModules`.
 * - `dev` runs kit's own Vite dev server (Node SSR, full HMR) with the
 *   target-provided adapter supplying the `platform` emulation.
 *
 * This module is target-agnostic: everything Cloudflare-specific lives in
 * `@distilled.cloud/sveltekit/cloudflare`.
 */
export const make: (
  options?: SvelteKitOptions,
) => Effect.Effect<Framework["Service"], never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (options?: SvelteKitOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseRoot = options?.root ?? (yield* Effect.sync(() => process.cwd()));

    const targetConfig: SvelteKitTargetConfig = {
      compatibilityDate: options?.compatibilityDate,
      compatibilityFlags: options?.compatibilityFlags,
      adapter: options?.adapter,
    };

    const resolveTarget = (root: string) =>
      FrameworkCore.resolveDeployTarget<SvelteKitTarget, SvelteKitTargetConfig>(
        root,
        options?.target ?? DEFAULT_TARGET_SPECIFIER,
        targetConfig,
      ).pipe(Effect.mapError((error) => fail(error.message, error.cause)));

    const requireAdapterHook = (target: SvelteKitTarget) =>
      typeof target.adapter === "function"
        ? Effect.succeed(target)
        : Effect.fail(
            fail(
              `The resolved "${target.platform}" deploy target does not implement the SvelteKit ` +
                "adapter hook (`adapter(context)`) and has no wholesale `build`",
            ),
          );

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
      const target = yield* resolveTarget(root);
      const targetContext = { root, framework: "sveltekit" };

      // Wholesale build takeover (targets that own the entire pipeline).
      if (target.build !== undefined) {
        return yield* target.build(targetContext).pipe(
          Effect.mapError((error) => fail(error.message, error.cause)),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }

      yield* requireAdapterHook(target);
      const adapter = target.adapter({ root });
      const vite = yield* loadVite(root);
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

      const output: FrameworkCore.BuildOutput = {
        distDirectory: path.resolve(root, "dist"),
        clientDirectory: result.dest,
        serverModules: undefined,
        externalWorkspaces: new Set<string>(),
      };

      // The target's finishing pass turns the adapter's on-disk worker entry
      // into runtime-ready server modules (e.g. the Cloudflare target's
      // rolldown re-bundle for workerd).
      return yield* FrameworkCore.applyDeployTargetFinish(target, output, {
        ...targetContext,
        entry: result.workerEntry,
      }).pipe(
        Effect.mapError((error) => fail(error.message, error.cause)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    });

    const dev: Framework["Service"]["dev"] = Effect.fn(function* (devOptions) {
      const root = devOptions?.root ?? baseRoot;
      const target = yield* resolveTarget(root);
      yield* requireAdapterHook(target);
      const adapter = target.adapter({
        root,
        dev: { env: options?.dev?.env, bindings: options?.dev?.bindings },
      });
      // Registered before the server is acquired so it runs after the server
      // closes (finalizers are LIFO): the dev platform (e.g. the Cloudflare
      // target's platform proxy) outlives the last in-flight request.
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await adapter.dispose?.();
          } catch {
            // dev-platform teardown is best-effort
          }
        }),
      );
      const vite = yield* loadVite(root);
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
