import {
  Framework,
  FrameworkError,
  readBuildOutput,
  writeBuildOutput,
  type BuildOutput,
} from "@distilled.cloud/framework-core";
import * as Miniflare from "@distilled.cloud/test-utils/miniflare";
import {
  moduleTypeFromExtension,
  type MiniflareModule,
} from "@distilled.cloud/test-utils/miniflare-module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { cast } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { Cwd } from "./Cwd.ts";
import * as Options from "./Options.ts";

export interface Instance {
  url: URL;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  fetchText(path: string, init?: RequestInit): Promise<string>;
  fetchJson<T>(path: string, init?: RequestInit): Promise<T>;
  dispose(): Promise<void>;
}

declare namespace Instance {
  type Raw = Omit<Instance, "dispose">;
}

export class Server extends Context.Service<
  Server,
  {
    readonly live: () => Effect.Effect<Instance.Raw, FrameworkError, Scope.Scope>;
    readonly dev: () => Effect.Effect<Instance.Raw, FrameworkError, Scope.Scope>;
  }
>()("@distilled.cloud/e2e/Server") {}

/**
 * Where the harness persists a fixture's `BuildOutput`, relative to the
 * fixture root. Persistence is the harness's E2E mechanism (preview serves
 * from it) — it is NOT part of the `Framework` contract; `Framework.build`
 * returns the `BuildOutput` purely in-memory.
 */
export const BUILD_OUTPUT_FILE = "dist/build.json";

/**
 * Run `Framework.build` and persist the returned `BuildOutput` to
 * {@link BUILD_OUTPUT_FILE} (framework-core's `writeBuildOutput`), so
 * `preview` can serve it without rebuilding.
 */
export const buildAndPersist: Effect.Effect<
  BuildOutput,
  FrameworkError,
  Framework | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const framework = yield* Framework;
  const path = yield* Path.Path;
  const cwd = yield* Cwd;
  const output = yield* framework.build();
  yield* writeBuildOutput(path.resolve(cwd, BUILD_OUTPUT_FILE), output).pipe(
    Effect.mapError(
      (cause) => new FrameworkError({ message: "Failed to write build.json", cause }),
    ),
  );
  return output;
});

export const layer = Layer.effect(
  Server,
  Effect.gen(function* () {
    const framework = yield* Framework;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* Cwd;
    const options = yield* Options.load();

    const buildJsonPath = path.resolve(cwd, BUILD_OUTPUT_FILE);
    const persistedBuild = buildAndPersist.pipe(
      Effect.provideService(Framework, framework),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    const live = () =>
      readBuildOutput(buildJsonPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.catch(() => persistedBuild),
        Effect.flatMap((build) => {
          const modules = build.serverModules?.flatMap(
            (module): MiniflareModule | Array<MiniflareModule> => {
              const type = moduleTypeFromExtension(path.extname(module.name));
              if (type === "SourceMap") {
                return [];
              }
              return {
                path: module.name,
                type,
                contents: module.content as string | Uint8Array<ArrayBuffer> | undefined,
              };
            },
          );
          return Effect.acquireDisposable(
            Effect.promise(
              async () =>
                await Miniflare.createMiniflare({
                  ...options.miniflare,
                  assets:
                    options.miniflare.assets && build.clientDirectory
                      ? {
                          ...options.miniflare.assets,
                          directory: build.clientDirectory,
                        }
                      : undefined,
                  modules: modules ?? options.miniflare.modules ?? [],
                }),
            ),
          ).pipe(Effect.map(cast<Miniflare.MiniflareInstance, Instance>));
        }),
      );

    const dev = () =>
      framework.dev().pipe(
        Effect.map((server) => {
          const url = new URL(server.url);
          const baseFetch = (path: string, init?: RequestInit) => fetch(new URL(path, url), init);
          return {
            url,
            fetch: baseFetch,
            fetchText: (path: string, init?: RequestInit) =>
              baseFetch(path, init).then((response) => response.text()),
            fetchJson: <T>(path: string, init?: RequestInit) =>
              baseFetch(path, init).then((response) => response.json() as Promise<T>),
          };
        }),
      );

    return Server.of({
      live,
      dev,
    });
  }),
);
