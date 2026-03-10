/**
 * Module rule parsing and defaults.
 *
 * Port of wrangler's deployment-bundle/rules.ts — defines the default
 * module rules for Cloudflare Workers and handles rule merging with
 * fallthrough semantics.
 */
import type { CfModuleType } from "./cf-module.js";

/**
 * Module rule types matching Cloudflare's config schema.
 */
export type ConfigModuleRuleType =
	| "ESModule"
	| "CommonJS"
	| "CompiledWasm"
	| "Text"
	| "Data";

/**
 * A module rule defining how non-JS file types are handled.
 */
export interface Rule {
	readonly type: ConfigModuleRuleType;
	readonly globs: ReadonlyArray<string>;
	readonly fallthrough?: boolean;
}

/**
 * Maps config rule types to internal module types.
 */
export const RuleTypeToModuleType: Record<ConfigModuleRuleType, CfModuleType> =
	{
		ESModule: "esm",
		CommonJS: "commonjs",
		CompiledWasm: "compiled-wasm",
		Data: "buffer",
		Text: "text",
	};

/**
 * Returns true if the rule type is ESModule or CommonJS (JavaScript).
 */
export function isJavaScriptModuleRule(rule: Rule): boolean {
	return rule.type === "ESModule" || rule.type === "CommonJS";
}

/**
 * Default module rules matching Cloudflare Workers conventions.
 *
 * - `.txt`, `.html`, `.sql` → Text modules
 * - `.bin` → Data (binary) modules
 * - `.wasm`, `.wasm?module` → CompiledWasm modules
 */
export const DEFAULT_MODULE_RULES: Array<Rule> = [
	{ type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
	{ type: "Data", globs: ["**/*.bin"] },
	{ type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

export interface ParsedRules {
	readonly rules: Array<Rule>;
	readonly removedRules: Array<Rule>;
}

/**
 * Parses user-defined module rules, merges them with defaults,
 * and handles fallthrough semantics.
 *
 * Rules without `fallthrough: true` "complete" their type — any
 * subsequent rules of the same type are marked as removed.
 */
export function parseRules(userRules: readonly Rule[] = []): ParsedRules {
	const rules: Rule[] = [...userRules, ...DEFAULT_MODULE_RULES];

	const completedRuleLocations: Record<string, number> = {};
	const rulesToRemove: Rule[] = [];
	let index = 0;

	for (const rule of rules) {
		if (rule.type in completedRuleLocations) {
			rulesToRemove.push(rule);
		}
		if (!(rule.type in completedRuleLocations) && rule.fallthrough !== true) {
			completedRuleLocations[rule.type] = index;
		}
		index++;
	}

	for (const rule of rulesToRemove) {
		const idx = rules.indexOf(rule);
		if (idx !== -1) {
			rules.splice(idx, 1);
		}
	}

	return { rules, removedRules: rulesToRemove };
}
