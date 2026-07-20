import type { CloudflareVitePluginOptions } from "@distilled.cloud/cloudflare-vite-plugin";
import type { Framework } from "@distilled.cloud/framework-core";
import type * as Miniflare from "@distilled.cloud/test-utils/miniflare";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { Cwd } from "./Cwd.ts";

const kOptions = Symbol("@distilled.cloud/e2e/Options");

export interface Options {
  /**
   * Cloudflare worker configuration (compatibility date/flags, worker name,
   * bindings, assets) consumed by the built-in Vite implementation of the
   * `Framework` service — and, by convention, by framework packages named via
   * {@link Options.framework} (they read the same shape for their cloudflare
   * plugin options). Optional so assets-only or non-Vite fixtures can omit it.
   */
  readonly vite?: CloudflareVitePluginOptions;
  readonly miniflare: Options.MiniflareOptions;
  /**
   * The framework integration implementing `dev`/`build` for this fixture.
   *
   * - omitted — the built-in Vite implementation (default; zero behavior
   *   change for existing fixtures)
   * - a package specifier (e.g. `"@distilled.cloud/waku"`) — loaded from the
   *   *fixture's* own `node_modules`; the module must default-export (or
   *   named-export `framework`) a factory `(options: Options) =>
   *   Layer<Framework>` (a `Layer<Framework>` export is also accepted)
   * - a factory function — called with these options
   * - a `Layer<Framework>` — used as-is (build it yourself in `e2e.config.ts`
   *   by importing the framework package directly, for full type safety over
   *   framework-specific options)
   */
  readonly framework?: Options.FrameworkInput;
}

export declare namespace Options {
  type Input = Options | Effect.Effect<Options>;
  type MiniflareOptions = {
    [K in keyof Miniflare.Options]?: K extends "assets"
      ? Omit<Miniflare.Options[K], "directory">
      : Miniflare.Options[K];
  };

  /**
   * Services the harness runtime provides to a framework Layer while it is
   * being built (from `@effect/platform-node`'s `NodeServices`, plus a
   * dotenv/env `ConfigProvider`).
   */
  type FrameworkServices = FileSystem.FileSystem | Path.Path;

  /**
   * What a framework integration ultimately provides: a Layer for
   * framework-core's `Framework` service.
   */
  type FrameworkLayer = Layer.Layer<Framework, unknown, FrameworkServices>;

  /**
   * A factory producing the {@link FrameworkLayer} from the fixture's
   * options. May return the Layer directly or an Effect of it.
   */
  type FrameworkFactory = (
    options: Options,
  ) => FrameworkLayer | Effect.Effect<FrameworkLayer, unknown, FrameworkServices>;

  type FrameworkInput = string | FrameworkLayer | FrameworkFactory;
}

export const make = (options: Options.Input) => Object.assign(options, { [kOptions]: true });

export const load = Effect.fn(function* () {
  const path = yield* Path.Path;
  const cwd = yield* Cwd;
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
