/**
 * Module deduplication.
 *
 * Removes duplicate modules from an array by name,
 * preferring modules that appear later (last-wins).
 */
import type { CfModule } from "./cf-module.js";

export function dedupeModulesByName(modules: CfModule[]): CfModule[] {
	return Object.values(
		modules.reduce(
			(moduleMap, module) => {
				moduleMap[module.name] = module;
				return moduleMap;
			},
			{} as Record<string, CfModule>,
		),
	);
}
