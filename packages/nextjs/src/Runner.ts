import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";

export class RunnerError extends Data.TaggedError<"RunnerError">("RunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The JSON configuration passed to `runner.mjs` (as `process.argv[2]`).
 * Mirrors the shape the runner script parses.
 */
export interface RunnerConfig {
  /** The Next.js app root (the directory containing `open-next.config.ts`). */
  readonly appDir: string;
  /** Path of the OpenNext config, relative to `appDir`. @default "open-next.config.ts" */
  readonly configPath?: string | undefined;
  /** `compatibility_date` of the in-memory wrangler-config stand-in. */
  readonly compatibilityDate: string;
  /** Skip the internal `next build` (reuse an existing `.next`). @default false */
  readonly skipNextBuild?: boolean | undefined;
  /** Minify the OpenNext bundling steps. @default false */
  readonly minify?: boolean | undefined;
  /** Enable OpenNext debug logging. @default false */
  readonly debug?: boolean | undefined;
  /**
   * The command the pipeline runs to build the Next.js app. Defaults (in the
   * runner) to `npx next build` — NOT the app's `build` script, which by
   * fixture convention is `e2e build` and would recurse into this runner.
   */
  readonly buildCommand?: string | undefined;
}

/** Absolute path of the runner script (`runner.mjs` sibling of this module). */
export const runnerPath = (): string => fileURLToPath(new URL("./runner.mjs", import.meta.url));

/**
 * Run the programmatic `@opennextjs/cloudflare` build pipeline in a
 * disposable `node` child process (`runner.mjs`). The pipeline mutates
 * cwd-coupled module state, spawns `next build`, and can `process.exit(1)`,
 * so it must never run inside the calling process.
 *
 * Output is piped and forwarded through the parent's `process.stdout` /
 * `process.stderr` stream writes (NOT fd-level `"inherit"`) so `next build`
 * progress still streams to the terminal, while harnesses that patch the
 * JS-level writers (e.g. alchemy-test's stray-output capture) can divert it
 * into their logs instead of having it corrupt reporter output.
 */
export const runOpenNextBuild = (
  config: RunnerConfig,
): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("node", [runnerPath(), JSON.stringify(config)], {
      cwd: config.appDir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Look the writer up at call time — harnesses swap the property.
    const forward = (
      stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
      target: "stdout" | "stderr",
    ) =>
      Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => {
          process[target].write(chunk);
        }),
      );
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command);
        // Drain stdout/stderr concurrently with waiting for exit — an unread
        // pipe eventually fills and blocks the build.
        const [code] = yield* Effect.all(
          [handle.exitCode, forward(handle.stdout, "stdout"), forward(handle.stderr, "stderr")],
          { concurrency: "unbounded" },
        );
        return code;
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RunnerError({
            message: "Failed to spawn the OpenNext build runner (is `node` on PATH?)",
            cause,
          }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new RunnerError({
        message: `The OpenNext build pipeline exited with code ${exitCode}`,
      });
    }
  });
