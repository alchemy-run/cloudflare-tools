/**
 * Distilled-bundler adapter for the test harness.
 *
 * Converts test harness BundleConfig into the bundler's BundleOptions,
 * runs the bundle, and converts the result back to test harness BundleResult.
 */
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BundleLive, bundle, type BundleOptions } from "../../src/bundle.js";
import { BundleError } from "./bundler-adapter.js";
import type {
	BundleConfig,
	BundleResult,
	CfModule,
	CfModuleType,
} from "./types.js";

/**
 * Bundles a fixture using distilled-bundler.
 */
export function bundleWithDistilled(
	config: BundleConfig,
): Effect.Effect<BundleResult, BundleError> {
	return Effect.gen(function* () {
		// Create a temp directory for output
		const outdir = fs.mkdtempSync(
			path.join(os.tmpdir(), "distilled-bundler-distilled-"),
		);

		// Convert test harness config to bundler options
		const options: BundleOptions = {
			entryPoint: config.entryPoint,
			projectRoot: config.projectRoot,
			outputDir: outdir,
			compatibilityDate: config.compatibilityDate,
			compatibilityFlags: config.compatibilityFlags,
			define: config.define,
			rules: config.rules?.map((r) => ({
				type: r.type,
				globs: [...r.globs],
				fallthrough: r.fallthrough,
			})),
			findAdditionalModules: config.findAdditionalModules,
			preserveFileNames: config.preserveFileNames,
			external: config.external ? [...config.external] : undefined,
		};

		// Run the bundle
		const result = yield* bundle(options).pipe(
			Effect.provide(BundleLive),
			Effect.mapError(
				(error) =>
					new BundleError({
						message: `Distilled bundler failed: ${String(error)}`,
						cause: error,
					}),
			),
		);

		// Convert to test harness BundleResult
		// filePath must point to the written output file (used by Miniflare to load from disk)
		const entryDir = path.dirname(result.entryPoint);
		return {
			entryPoint: result.entryPoint,
			modules: result.modules.map(
				(m): CfModule => ({
					name: m.name,
					filePath: path.resolve(entryDir, m.name),
					type: m.type as CfModuleType,
				}),
			),
			bundleType: result.bundleType,
			outputDir: result.outputDir,
		} satisfies BundleResult;
	});
}
