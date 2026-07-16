import type { CloudflareVitePluginOptions } from "@distilled.cloud/cloudflare-vite-plugin";
import type * as Miniflare from "@distilled.cloud/test-utils/miniflare";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Runtime from "./Runtime.ts";

const kOptions = Symbol("@distilled.cloud/e2e/Options");

export interface Options {
  readonly vite: CloudflareVitePluginOptions;
  readonly miniflare: Options.MiniflareOptions;
}

export declare namespace Options {
  type Input = Options | Effect.Effect<Options>;
  type MiniflareOptions = {
    [K in keyof Miniflare.Options]?: K extends "assets"
      ? Omit<Miniflare.Options[K], "directory">
      : Miniflare.Options[K];
  };
}

export const make = (options: Options.Input) => Object.assign(options, { [kOptions]: true });

export const load = Effect.fn(function* () {
  const path = yield* Path.Path;
  const cwd = yield* Runtime.Cwd;
  const url = yield* path
    .toFileUrl(path.resolve(cwd, "e2e.config.ts"))
    .pipe(Effect.map((url) => url.href));
  const options = yield* Effect.promise(
    async () => await import(url).then((m) => m.default as Options.Input),
  );
  if (Effect.isEffect(options)) {
    return yield* options;
  }
  if (!Predicate.hasProperty(options, kOptions)) {
    throw new Error("No e2e.config.ts found");
  }
  return options;
});
