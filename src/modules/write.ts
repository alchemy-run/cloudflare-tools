/**
 * Write additional modules to the output directory.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type { CfModule } from "./cf-module.js";

/**
 * Writes collected modules (WASM, text, data) as separate files
 * to the output directory, preserving any subdirectory structure.
 */
export function writeAdditionalModules(
	fileSystem: FileSystem.FileSystem,
	path: Path.Path,
	modules: readonly CfModule[],
	destination: string,
	): Effect.Effect<void, PlatformError> {
	return Effect.forEach(
		modules,
		(module) => {
			const modulePath = path.resolve(destination, module.name);
			return Effect.gen(function* () {
				yield* fileSystem.makeDirectory(path.dirname(modulePath), {
					recursive: true,
				});
				yield* fileSystem.writeFile(modulePath, module.content);
			});
		},
		{ concurrency: 1, discard: true },
	);
}
