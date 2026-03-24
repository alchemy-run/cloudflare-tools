import globToRegExp from "glob-to-regexp";
import type { ModuleType } from "./Module.js";

export interface Rule {
  readonly type: ModuleType;
  readonly globs: ReadonlyArray<string>;
  readonly fallthrough?: boolean;
}

export interface Options {
  readonly rules?: ReadonlyArray<Rule>;
  readonly preserveFileNames?: boolean;
}

export const DEFAULT_MODULE_RULES: Array<Rule> = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

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
