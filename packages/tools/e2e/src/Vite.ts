import cloudflareVitePlugin, {
  type CloudflareVitePluginOptions,
} from "@distilled.cloud/cloudflare-vite-plugin";
import * as FrameworkCore from "@distilled.cloud/framework-core";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type * as ViteModule from "vite";
import { Cwd } from "./Cwd.ts";

export class ViteError extends Data.TaggedError<"ViteError">("ViteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type BuildOutput = FrameworkCore.BuildOutput;

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

export const ViteLive = Layer.effect(
  Vite,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* Cwd;

    const load = (root: string = cwd): Effect.Effect<typeof ViteModule, ViteError> =>
      FrameworkCore.loadProjectModule<typeof ViteModule>(root, "vite").pipe(
        Effect.mapError(
          (error) => new ViteError({ message: "Failed to load Vite", cause: error.cause }),
        ),
      );

    return Vite.of({
      build: Effect.fn(function* (pluginOptions, config) {
        const vite = yield* load(config?.root);
        const collector = yield* FrameworkCore.makeBuildOutputCollector({
          entryEnvironment: pluginOptions?.viteEnvironments?.entry,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        yield* Effect.tryPromise({
          try: async () => {
            const builder = await vite.createBuilder(
              {
                ...config,
                plugins: [
                  ...(config?.plugins ?? []),
                  cloudflareVitePlugin(pluginOptions),
                  collector.plugin,
                ],
              },
              null,
            );
            await builder.buildApp();
          },
          catch: (error) => new ViteError({ message: "Failed to build", cause: error }),
        });
        const result = yield* collector
          .collect()
          .pipe(
            Effect.mapError(
              (error) => new ViteError({ message: error.message, cause: error.cause }),
            ),
          );
        yield* FrameworkCore.writeBuildOutput(path.resolve(cwd, "dist/build.json"), result).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
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
        return yield* FrameworkCore.readBuildOutput(path.resolve(cwd, "dist/build.json")).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      }),
    });
  }),
);
