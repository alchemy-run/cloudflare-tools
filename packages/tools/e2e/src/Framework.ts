import { Framework, FrameworkError } from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Options from "./Options.ts";
import * as Vite from "./Vite.ts";

/**
 * The generic `Framework` service implemented over the e2e `Vite` service —
 * the first implementor of the framework-core contract. Framework packages
 * (waku/astro/sveltekit/nextjs) provide their own layers with the same shape.
 */
export const layer = Layer.effect(
  Framework,
  Effect.gen(function* () {
    const vite = yield* Vite.Vite;
    const options = yield* Options.load();
    const wrapError = (error: Vite.ViteError) =>
      new FrameworkError({ framework: "vite", message: error.message, cause: error.cause });
    return Framework.of({
      build: (buildOptions) =>
        vite
          .build(
            options.vite,
            buildOptions?.root !== undefined ? { root: buildOptions.root } : undefined,
          )
          .pipe(Effect.mapError(wrapError)),
      dev: (devOptions) =>
        vite
          .dev(options.vite, {
            ...(devOptions?.root !== undefined ? { root: devOptions.root } : undefined),
            ...(devOptions?.port !== undefined ? { server: { port: devOptions.port } } : undefined),
          })
          .pipe(
            Effect.map(({ url }) => ({ url })),
            Effect.mapError(wrapError),
          ),
      readBuildOutput: () => vite.readBuildOutput(),
    });
  }),
);
