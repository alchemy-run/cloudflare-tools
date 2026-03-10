/**
 * Extract entry point information from esbuild's metafile output.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Metafile } from "esbuild";

export class MissingMetafile extends Data.TaggedError("MissingMetafile")<{
	readonly entryFile: string;
}> {}

export class EntryPointNotFound extends Data.TaggedError("EntryPointNotFound")<{
	readonly entryFile: string;
	readonly entryPoints: ReadonlyArray<string>;
}> {}

export class MultipleEntryPoints extends Data.TaggedError("MultipleEntryPoints")<{
	readonly entryFile: string;
	readonly entryPoints: ReadonlyArray<string>;
}> {}

export type MetafileError =
	| MissingMetafile
	| EntryPointNotFound
	| MultipleEntryPoints;

/**
 * Computes entry-point information (path, exports, dependencies)
 * from esbuild's metafile output.
 */
export function getEntryPointFromMetafile(
	entryFile: string,
	metafile: Metafile | undefined,
): Effect.Effect<
	{
		readonly relativePath: string;
		readonly exports: ReadonlyArray<string>;
		readonly dependencies: Record<string, { bytesInOutput: number }>;
	},
	MetafileError
> {
	if (metafile === undefined) {
		return Effect.fail(new MissingMetafile({ entryFile }));
	}

	const entryPoints = Object.entries(metafile.outputs).filter(
		([_path, output]) => output.entryPoint !== undefined,
	);
	const entryPointList = entryPoints.flatMap(([_input, output]) =>
		output.entryPoint === undefined ? [] : [output.entryPoint],
	);

	if (entryPoints.length === 0) {
		return Effect.fail(
			new EntryPointNotFound({ entryFile, entryPoints: entryPointList }),
		);
	}

	if (entryPoints.length > 1) {
		return Effect.fail(
			new MultipleEntryPoints({ entryFile, entryPoints: entryPointList }),
		);
	}

	const [relativePath, entryPoint] = entryPoints[0]!;

	return Effect.succeed({
		relativePath,
		exports: entryPoint.exports,
		dependencies: entryPoint.inputs,
	});
}
