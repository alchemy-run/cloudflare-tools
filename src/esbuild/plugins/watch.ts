import type * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import type * as esbuild from "esbuild";
import type { BuildError } from "../../errors.js";

export function makeWatchPlugin<T extends esbuild.BuildOptions>(
  queue: Queue.Queue<esbuild.BuildResult<T>, BuildError | Cause.Done>,
): esbuild.Plugin {
  return {
    name: "distilled-watch",
    setup(build) {
      build.onEnd((result) => {
        Queue.offerUnsafe(queue, result);
      });
      build.onDispose(() => {
        Queue.shutdown(queue);
      });
    },
  };
}
