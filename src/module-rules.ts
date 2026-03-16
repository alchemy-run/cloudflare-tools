import globToRegExp from "glob-to-regexp";
import type { Module } from "./module.js";

/**
 * A module rule defining how non-JS file types are handled.
 * Port of wrangler's deployment-bundle/rules.ts.
 */
export interface Rule {
  readonly type: Module.Type;
  readonly globs: ReadonlyArray<string>;
  readonly fallthrough?: boolean;
}

/**
 * Default module rules matching Cloudflare Workers conventions.
 *
 * - `.txt`, `.html`, `.sql` -> Text modules
 * - `.bin` -> Data (binary) modules
 * - `.wasm`, `.wasm?module` -> CompiledWasm modules
 */
export const DEFAULT_MODULE_RULES: Array<Rule> = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

/**
 * Parses user-defined module rules, merges them with defaults,
 * and handles fallthrough semantics.
 */
export function parseRules(userRules: ReadonlyArray<Rule> = []): ReadonlyArray<Rule> {
  const rules: Array<Rule> = [...userRules, ...DEFAULT_MODULE_RULES];

  const completedRuleLocations: Record<string, number> = {};
  const rulesToRemove: Array<Rule> = [];
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

  return rules;
}

export const makeRuleFilters = (rules: ReadonlyArray<Rule>) =>
  rules.map((rule) => ({
    rule,
    filters: rule.globs.map((glob) => globToRegExp(glob)),
  }));
