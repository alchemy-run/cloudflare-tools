/**
 * esbuild plugin that collects non-JS modules (WASM, text, binary).
 *
 * For each import that matches a module rule, the plugin:
 * - Resolves the file on disk
 * - Reads the content and computes a SHA-1 hash
 * - Records the module in a shared mutable array
 * - Marks the import as external with a rewritten (hashed) path
 *
 * Port of wrangler's deployment-bundle/module-collection.ts.
 */
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import globToRegExp from "glob-to-regexp";
import type { Plugin } from "esbuild";
import type { CfModule } from "../modules/cf-module.js";
import { RuleTypeToModuleType, isJavaScriptModuleRule, parseRules } from "../modules/rules.js";
import type { Rule } from "../modules/rules.js";

/**
 * The result of createModuleCollector — contains both the esbuild plugin
 * and the mutable modules array that gets populated during the build.
 */
export interface ModuleCollector {
	/** Mutable array populated during the build */
	readonly modules: CfModule[];
	/** esbuild plugin to include in the build */
	readonly plugin: Plugin;
}

export interface ModuleCollectorOptions {
	/** Module rules (user-defined + defaults will be merged) */
	readonly rules?: readonly Rule[];
	/** Whether to preserve original filenames instead of hashing */
	readonly preserveFileNames?: boolean;
}

/**
 * Creates a module collector — an esbuild plugin + mutable modules array.
 *
 * Usage:
 * ```ts
 * const collector = createModuleCollector({ rules });
 * // Pass collector.plugin to esbuild plugins array
 * // After build, read collector.modules for collected WASM/text/data modules
 * ```
 */
export function createModuleCollector(
	options: ModuleCollectorOptions = {},
): ModuleCollector {
	const modules: CfModule[] = [];
	const { rules: parsedRules } = parseRules(options.rules);
	const preserveFileNames = options.preserveFileNames ?? false;

	const plugin: Plugin = {
		name: "distilled-module-collector",
		setup(build) {
			// Reset modules at the start of each build (for watch mode)
			build.onStart(() => {
				modules.splice(0);
			});

			// Register an onResolve handler for each rule + glob combination
			for (const rule of parsedRules) {
				// Skip JavaScript rules — let esbuild bundle those normally
				if (isJavaScriptModuleRule(rule)) {
					continue;
				}

				for (const glob of rule.globs) {
					const filter = globToRegExp(glob);

					build.onResolve({ filter }, async (args) => {
						// Prevent infinite recursion from our own resolve calls
						if (args.pluginData?.skip) {
							return undefined;
						}

						// Resolve the file path
						let filePath: string;
						try {
							const resolved = await build.resolve(args.path, {
								resolveDir: args.resolveDir,
								kind: args.kind,
								pluginData: { skip: true },
							});
							filePath = resolved.path;
						} catch {
							// Fallback to manual resolution
							filePath = path.resolve(args.resolveDir, args.path);
						}

						// Read file content and compute hash
						const fileContent = await readFile(filePath);
						const fileHash = crypto
							.createHash("sha1")
							.update(fileContent)
							.digest("hex");

						// Determine the output filename (no ./ prefix — just the hashed basename)
						const fileName = preserveFileNames
							? path.basename(args.path)
							: `${fileHash}-${path.basename(args.path)}`;

						// Record the module
						const moduleType = RuleTypeToModuleType[rule.type];
						modules.push({
							name: fileName,
							filePath,
							content: fileContent,
							type: moduleType,
						});

						// Mark as external so esbuild leaves the import intact
						return {
							path: fileName,
							external: true,
							watchFiles: [filePath],
						};
					});
				}
			}
		},
	};

	return { modules, plugin };
}
