import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import * as esbuild from "esbuild";

export interface EsbuildError extends esbuild.BuildFailure {
  readonly _tag: "EsbuildError";
}

export class Esbuild extends ServiceMap.Service<
  Esbuild,
  {
    readonly build: <T extends esbuild.BuildOptions>(
      options: esbuild.SameShape<esbuild.BuildOptions, T>,
    ) => Effect.Effect<esbuild.BuildResult<T>, EsbuildError>;
  }
>()("distilled-bundler/Esbuild") {}

export const EsbuildLive = Layer.succeed(
  Esbuild,
  Esbuild.of({
    build: (options) =>
      Effect.tryPromise({
        try: () => esbuild.build(options),
        catch: (error) =>
          Object.assign(error as esbuild.BuildFailure, {
            _tag: "EsbuildError",
          }) as EsbuildError,
      }),
  }),
);
