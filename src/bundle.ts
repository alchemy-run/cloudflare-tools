/**
 * Main bundle orchestrator.
 *
 * Assembles esbuild options and plugins, runs the build via the Esbuild
 * Effect service, and post-processes the result into a BundleResult.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as ServiceMap from "effect/ServiceMap";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Esbuild } from "./esbuild.js";
import { EsbuildLive, type EsbuildError } from "./esbuild.js";
import {
	getEntryPointFromMetafile,
	type MetafileError,
} from "./metafile.js";
import type { CfModule } from "./modules/cf-module.js";
import { dedupeModulesByName } from "./modules/dedupe.js";
import { writeAdditionalModules } from "./modules/write.js";
import type { Rule } from "./modules/rules.js";
import { cloudflareInternalPlugin } from "./plugins/cloudflare-internal.js";
import { createModuleCollector } from "./plugins/module-collector.js";
import { nodejsCompatPlugin } from "./plugins/nodejs-compat.js";
import type { Plugin } from "esbuild";

export interface BundleOptions {
	/** Absolute path to the entry point */
	readonly entryPoint: string;
	/** Absolute path to the project root */
	readonly projectRoot: string;
	/** Absolute path to the output directory */
	readonly outputDir: string;
	/** Cloudflare compatibility date */
	readonly compatibilityDate?: string;
	/** Cloudflare compatibility flags (e.g., ["nodejs_compat"]) */
	readonly compatibilityFlags?: readonly string[];
	/** esbuild define replacements */
	readonly define?: Record<string, string>;
	/** Module rules for non-JS imports */
	readonly rules?: readonly Rule[];
	/** Whether to scan the filesystem for additional modules */
	readonly findAdditionalModules?: boolean;
	/** Preserve original file names instead of content-hashing */
	readonly preserveFileNames?: boolean;
	/** Additional imports to mark as external */
	readonly external?: readonly string[];
}

export interface BundleResult {
	/** Absolute path to the main output file */
	readonly entryPoint: string;
	/** Additional modules collected during bundling */
	readonly modules: readonly CfModule[];
	/** The module format of the entry point */
	readonly bundleType: "esm" | "commonjs";
	/** Absolute path to the output directory */
	readonly outputDir: string;
}

export class BundleFileSystemError extends Data.TaggedError(
	"BundleFileSystemError",
)<{
	readonly cause: PlatformError;
}> {}

export class BundleEsbuildError extends Data.TaggedError("BundleEsbuildError")<{
	readonly cause: EsbuildError;
}> {}

export class BundleMetafileError extends Data.TaggedError("BundleMetafileError")<{
	readonly cause: MetafileError;
}> {}

export type BundleError =
	| BundleEsbuildError
	| BundleMetafileError
	| BundleFileSystemError;

export class Bundle extends ServiceMap.Service<
	Bundle,
	{
		readonly bundle: (
			options: BundleOptions,
		) => Effect.Effect<BundleResult, BundleError>;
	}
>()("distilled-bundler/Bundle") {}

export const bundle = (options: BundleOptions) =>
	Effect.gen(function* () {
		const bundler = yield* Bundle;
		return yield* bundler.bundle(options);
	});

/**
 * Common esbuild options matching wrangler's configuration.
 */
const COMMON_ESBUILD_OPTIONS = {
	target: "es2024",
	loader: {
		".js": "jsx" as const,
		".mjs": "jsx" as const,
		".cjs": "jsx" as const,
	},
};

/**
 * Build conditions for Cloudflare Workers.
 * These affect how package.json "exports" fields are resolved.
 */
const BUILD_CONDITIONS = ["workerd", "worker", "browser"];

/**
 * Bundles a Cloudflare Worker entry point using esbuild.
 *
 * Effectful bundle service entrypoint.
 */
const makeBundle = Effect.gen(function* () {
	const esbuild = yield* Esbuild;
	const fileSystem = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	return Bundle.of({
		bundle: (options) =>
			Effect.gen(function* () {
				const plugins = createPlugins(options);
				const moduleCollector = plugins.moduleCollector;

				const result = yield* esbuild
					.build({
						entryPoints: [options.entryPoint],
						bundle: true,
						absWorkingDir: options.projectRoot,
						outdir: options.outputDir,
						format: "esm",
						target: COMMON_ESBUILD_OPTIONS.target,
						sourcemap: true,
						metafile: true,
						conditions: BUILD_CONDITIONS,
						define: buildDefine(options),
						loader: COMMON_ESBUILD_OPTIONS.loader,
						logLevel: "silent",
						external: [...(options.external ?? [])],
						plugins: plugins.plugins,
					})
					.pipe(Effect.mapError((cause) => new BundleEsbuildError({ cause })));

				const entryPointInfo = yield* getEntryPointFromMetafile(
					options.entryPoint,
					result.metafile,
				).pipe(
					Effect.mapError((cause) => new BundleMetafileError({ cause })),
				);

				const bundleType =
					entryPointInfo.exports.length > 0 ? "esm" : "commonjs";
				const resolvedEntryPoint = path.resolve(
					options.outputDir,
					entryPointInfo.relativePath,
				);
				const modules = dedupeModulesByName([...moduleCollector.modules]);

				if (modules.length > 0) {
					yield* writeAdditionalModules(
						fileSystem,
						path,
						modules,
						path.dirname(resolvedEntryPoint),
					).pipe(
						Effect.mapError((cause) => new BundleFileSystemError({ cause })),
					);
				}

				return {
					entryPoint: resolvedEntryPoint,
					modules,
					bundleType,
					outputDir: options.outputDir,
				} satisfies BundleResult;
			}),
	});
});

const BundleBaseLive = Layer.effect(Bundle, makeBundle);

export const BundleLive = BundleBaseLive.pipe(
	Layer.provide(Layer.mergeAll(EsbuildLive, NodeFileSystem.layer, NodePath.layer)),
);

function createPlugins(options: BundleOptions): {
	readonly moduleCollector: ReturnType<typeof createModuleCollector>;
	readonly plugins: Array<Plugin>;
} {
	const plugins: Array<Plugin> = [];
	const moduleCollector = createModuleCollector({
		rules: options.rules ? [...options.rules] : undefined,
		preserveFileNames: options.preserveFileNames,
	});
	plugins.push(moduleCollector.plugin);

	const hasNodejsCompat = options.compatibilityFlags?.some(
		(flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2",
	);
	if (hasNodejsCompat) {
		plugins.push(
			nodejsCompatPlugin({
				compatibilityDate: options.compatibilityDate,
				compatibilityFlags: options.compatibilityFlags,
			}),
		);
	}

	plugins.push(cloudflareInternalPlugin);

	return { moduleCollector, plugins };
}

function buildDefine(options: BundleOptions): Record<string, string> {
	return {
		"process.env.NODE_ENV": '"production"',
		"global.process.env.NODE_ENV": '"production"',
		"globalThis.process.env.NODE_ENV": '"production"',
		...options.define,
	};
}
