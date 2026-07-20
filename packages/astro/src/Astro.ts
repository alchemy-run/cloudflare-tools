import type { CloudflareVitePluginOptions } from "@distilled.cloud/cloudflare-vite-plugin";
import * as FrameworkCore from "@distilled.cloud/framework-core";
import type { AstroInlineConfig } from "astro";
import type * as AstroNamespace from "astro";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as ViteModule from "vite";
import { distilledCloudflare, NODE_ENVIRONMENTS } from "./integration.ts";

type AstroModule = typeof AstroNamespace;

/**
 * Options for the Astro `Framework` integration. Follows the e2e harness
 * convention: `vite` carries the cloudflare worker configuration
 * (compatibility date/flags, worker name/bindings/assets).
 */
export interface AstroFrameworkOptions {
  /**
   * Cloudflare plugin options (worker name, bindings, assets behavior,
   * compatibility date/flags) forwarded to the adapter's
   * `@distilled.cloud/cloudflare-vite-plugin` instance. `main`,
   * `viteEnvironments`, and the Astro node environments in
   * `skipEnvironments` are managed by the integration.
   */
  readonly vite?: CloudflareVitePluginOptions | undefined;
  /**
   * Extra Astro config merged into the in-memory `AstroInlineConfig`
   * (`site`, `base`, `integrations`, `devToolbar`, `vite`, ...). `root`,
   * `configFile: false`, and `adapter` are pinned by the integration and
   * cannot be overridden; `output` defaults to `"server"`.
   */
  readonly astro?: AstroInlineConfig | undefined;
  /**
   * The name of the KV binding injected into Astro's session config when
   * present on the Worker env.
   * @default "SESSION"
   */
  readonly sessionKVBindingName?: string | undefined;
  /** Project root. Defaults to the process working directory. */
  readonly root?: string | undefined;
}

/** Inputs for {@link makeAstroInlineConfig} (exported for testing). */
export interface AstroConfigInputs {
  /** Absolute project root. */
  readonly root: string;
  /** Cloudflare plugin options (harness convention: `options.vite`). */
  readonly pluginOptions?: CloudflareVitePluginOptions | undefined;
  /** User Astro config merged in (its `vite.plugins` are preserved). */
  readonly userConfig?: AstroInlineConfig | undefined;
  /** Session KV binding name forwarded to the adapter. */
  readonly sessionKVBindingName?: string | undefined;
  /** Dev-server port (merged into `server.port`). */
  readonly port?: number | undefined;
  /**
   * Extra Vite plugins appended after the user's (e.g. the build-output
   * collector).
   */
  readonly extraVitePlugins?: ReadonlyArray<ViteModule.Plugin> | undefined;
}

/**
 * Build the in-memory `AstroInlineConfig` — the whole replacement for
 * `astro.config.*` and `wrangler.json`:
 *
 * - `configFile: false` so the config is fully programmatic.
 * - `adapter` is pinned to this package's wrangler-free fork of
 *   `@astrojs/cloudflare` (over `@distilled.cloud/cloudflare-vite-plugin`).
 * - `output` defaults to `"server"` (overridable via the user config).
 * - User `vite.plugins` are preserved ahead of the collector.
 */
export const makeAstroInlineConfig = (inputs: AstroConfigInputs): AstroInlineConfig => {
  const user = inputs.userConfig;
  const port = inputs.port;
  const server: AstroInlineConfig["server"] =
    port === undefined
      ? user?.server
      : typeof user?.server === "function"
        ? (options) => ({ ...(user.server as (options: unknown) => object)(options), port })
        : { ...user?.server, port };
  return {
    output: "server",
    logLevel: "warn",
    ...user,
    root: inputs.root,
    configFile: false,
    adapter: distilledCloudflare({
      vite: inputs.pluginOptions,
      sessionKVBindingName: inputs.sessionKVBindingName,
    }),
    server,
    vite: {
      ...user?.vite,
      plugins: [...(user?.vite?.plugins ?? []), ...(inputs.extraVitePlugins ?? [])],
    },
  };
};

/**
 * The Astro implementation of framework-core's `Framework` service.
 *
 * - `build` runs astro's programmatic `build(AstroInlineConfig)` with the
 *   forked adapter and the shared build-output collector on the `ssr`
 *   environment (skipping astro's node-side `astro`/`prerender`
 *   environments), then persists `dist/build.json`. `serverModules[0]` is the
 *   ssr entry chunk (`server/entry.mjs`); `clientDirectory` is `dist/client`,
 *   captured as a path so prerendered HTML written after the Vite build rides
 *   along.
 * - `dev` runs astro's `dev()`; the `ssr` environment executes inside workerd
 *   via the cloudflare-vite-plugin module runner, with in-memory bindings —
 *   no wrangler config anywhere. Closing the Scope stops the server.
 */
export const make = (
  options?: AstroFrameworkOptions,
): Layer.Layer<FrameworkCore.Framework, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    FrameworkCore.Framework,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const fail = (message: string) => (cause: unknown) =>
        new FrameworkCore.FrameworkError({ framework: "astro", message, cause });

      // Astro's dev()/build() record telemetry events by default.
      yield* Effect.sync(() => {
        process.env.ASTRO_TELEMETRY_DISABLED ??= "1";
      });

      const distDir = options?.astro?.outDir ?? "dist";

      const resolveRoot = (override: string | undefined) =>
        Effect.sync(() => path.resolve(override ?? options?.root ?? process.cwd()));

      const buildJsonPath = (root: string) => path.resolve(root, distDir, "build.json");

      const loadAstro = (root: string): Effect.Effect<AstroModule, FrameworkCore.FrameworkError> =>
        FrameworkCore.loadProjectModule<AstroModule>(root, "astro").pipe(
          Effect.mapError(fail("Failed to load the project's astro")),
        );

      const makeConfig = (
        root: string,
        overrides?: Pick<AstroConfigInputs, "port" | "extraVitePlugins">,
      ): AstroInlineConfig =>
        makeAstroInlineConfig({
          root,
          pluginOptions: options?.vite,
          userConfig: options?.astro,
          sessionKVBindingName: options?.sessionKVBindingName,
          ...overrides,
        });

      return FrameworkCore.Framework.of({
        build: Effect.fn(function* (buildOptions) {
          const root = yield* resolveRoot(buildOptions?.root);
          const astro = yield* loadAstro(root);
          const collector = yield* FrameworkCore.makeBuildOutputCollector({
            entryEnvironment: "ssr",
            skipEnvironments: NODE_ENVIRONMENTS,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          const config = makeConfig(root, { extraVitePlugins: [collector.plugin] });
          yield* Effect.tryPromise({
            try: async () => await astro.build(config),
            catch: fail("Failed to build"),
          });
          // Disk re-read: astro injects the serialized SSR manifest into the
          // entry chunk on disk *after* the bundler finishes (the in-memory
          // capture still contains the `@@ASTRO_MANIFEST_REPLACE@@`
          // placeholder), and prunes the prerender-only chunks.
          const output = yield* collector
            .collect({ fromDisk: true })
            .pipe(Effect.mapError((error) => fail(error.message)(error.cause)));
          yield* FrameworkCore.writeBuildOutput(buildJsonPath(root), output).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.mapError(fail("Failed to write build.json")),
          );
          return output;
        }),
        dev: Effect.fn(function* (devOptions) {
          const root = yield* resolveRoot(devOptions?.root);
          const astro = yield* loadAstro(root);
          const config = makeConfig(root, { port: devOptions?.port });
          const server = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => await astro.dev(config),
              catch: fail("Failed to start the astro dev server"),
            }),
            (server) => Effect.promise(async () => await server.stop()),
          );
          const url =
            server.resolvedUrls?.local[0] ??
            (typeof server.address.port === "number"
              ? `http://localhost:${server.address.port}/`
              : undefined);
          if (url === undefined) {
            return yield* Effect.fail(
              fail("Could not determine the URL of the astro dev server")(undefined),
            );
          }
          return { url };
        }),
        readBuildOutput: Effect.fn(function* () {
          const root = yield* resolveRoot(undefined);
          return yield* FrameworkCore.readBuildOutput(buildJsonPath(root)).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          );
        }),
      });
    }),
  );
