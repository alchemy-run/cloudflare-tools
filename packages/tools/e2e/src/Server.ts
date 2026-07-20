import { Framework, type FrameworkError } from "@distilled.cloud/framework-core";
import * as Miniflare from "@distilled.cloud/test-utils/miniflare";
import {
  moduleTypeFromExtension,
  type MiniflareModule,
} from "@distilled.cloud/test-utils/miniflare-module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
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

export const layer = Layer.effect(
  Server,
  Effect.gen(function* () {
    const framework = yield* Framework;
    const path = yield* Path.Path;
    const options = yield* Options.load();

    const live = () =>
      framework.readBuildOutput().pipe(
        Effect.catch(() => framework.build()),
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
