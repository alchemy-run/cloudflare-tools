/**
 * Extract entry point information from esbuild's metafile output.
 */
import * as Effect from "effect/Effect";
import type { Metafile } from "esbuild";
import { ValidationError } from "../errors.js";

export interface Entrypoint {
  readonly relativePath: string;
  readonly exports: ReadonlyArray<string>;
  readonly dependencies: Record<string, { bytesInOutput: number }>;
}

/**
 * Computes entry-point information (path, exports, dependencies)
 * from esbuild's metafile output.
 */
export function getEntryPointFromMetafile(
  metafile: Metafile | undefined,
): Effect.Effect<Entrypoint, ValidationError> {
  if (metafile === undefined) {
    return Effect.fail(
      new ValidationError({
        reason: "MissingMetafile",
        message: "The build output does not include a metafile.",
      }),
    );
  }

  const entrypoints: Array<Entrypoint> = [];
  for (const [relativePath, output] of Object.entries(metafile.outputs)) {
    if (output.entryPoint !== undefined) {
      entrypoints.push({ relativePath, exports: output.exports, dependencies: output.inputs });
    }
  }

  if (!entrypoints[0]) {
    return Effect.fail(
      new ValidationError({
        reason: "MissingEntrypoints",
        message: "The build output does not include any entrypoints.",
      }),
    );
  } else if (entrypoints.length > 1) {
    return Effect.fail(
      new ValidationError({
        reason: "MultipleEntrypoints",
        message:
          "The build output contains more than one entrypoint:\n" +
          entrypoints.map((entrypoint) => `- ${entrypoint.relativePath}`).join("\n"),
      }),
    );
  }

  return Effect.succeed(entrypoints[0]);
}
