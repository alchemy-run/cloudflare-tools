import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import type { BuildOutput } from "./BuildOutput.ts";

export class FrameworkError extends Data.TaggedError<"FrameworkError">("FrameworkError")<{
  /** The framework the implementation drives (e.g. "vite", "waku", "astro"). */
  readonly framework?: string | undefined;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FrameworkBuildOptions {
  /** Project root. Defaults to the implementation's configured root / cwd. */
  readonly root?: string | undefined;
}

export interface FrameworkDevOptions {
  /** Project root. Defaults to the implementation's configured root / cwd. */
  readonly root?: string | undefined;
  /** Port for the dev server. Defaults to the framework's own choice. */
  readonly port?: number | undefined;
}

export interface FrameworkDevServer {
  /** The local URL the dev server is listening on. */
  readonly url: string;
}

/**
 * The common contract every framework integration implements — the shape the
 * e2e harness drives and the alchemy-side `SourceProvider` adapters wrap.
 *
 * Each framework package exports a concrete `Layer<Framework>` (and may expose
 * its own richer service alongside; e.g. the e2e harness's `Vite` service
 * accepts plugin/config parameters that this contract intentionally omits).
 *
 * Semantics:
 *
 * - `build` runs the framework's production build and returns the
 *   {@link BuildOutput} contract (`serverModules` entry-first). Implementations
 *   also persist the result as `dist/build.json` (via `writeBuildOutput`) so
 *   preview flows stay uniform across frameworks.
 * - `dev` starts the framework's dev server; it is scoped — closing the Scope
 *   stops the server.
 * - `readBuildOutput` loads the persisted `dist/build.json` from a previous
 *   `build` without rebuilding.
 *
 * A `SourceProvider` adapter maps `build` onto its own output shape
 * (`clientDirectory` → assets read, `serverModules` → bundle files entry-first,
 * `externalWorkspaces` → additional watched workspaces) and `dev` onto a
 * server-mode dev handle.
 */
export class Framework extends Context.Service<
  Framework,
  {
    readonly build: (options?: FrameworkBuildOptions) => Effect.Effect<BuildOutput, FrameworkError>;
    readonly dev: (
      options?: FrameworkDevOptions,
    ) => Effect.Effect<FrameworkDevServer, FrameworkError, Scope.Scope>;
    readonly readBuildOutput: () => Effect.Effect<BuildOutput, PlatformError>;
  }
>()("@distilled.cloud/framework-core/Framework") {}
