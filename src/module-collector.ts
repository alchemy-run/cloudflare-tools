import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Module } from "./module.js";
import { makeRuleFilters, parseRules, type Rule } from "./module-rules.js";

export interface ModuleCollectorOptions {
  readonly rules?: ReadonlyArray<Rule>;
  readonly preserveFileNames?: boolean;
}

/**
 * Bundler-agnostic module collection core shared by backend adapters.
 */
export class ModuleCollectorCore {
  readonly #preserveFileNames: boolean;
  readonly #rules;
  #modules: Record<string, Module> = {};

  constructor(options: ModuleCollectorOptions = {}) {
    this.#preserveFileNames = options.preserveFileNames ?? false;
    this.#rules = makeRuleFilters(parseRules(options.rules));
  }

  reset(): void {
    this.#modules = {};
  }

  match(importPath: string): Module.Type | null {
    for (const { rule, filters } of this.#rules) {
      if (rule.type === "ESModule" || rule.type === "CommonJS") {
        continue;
      }

      if (filters.some((filter) => filter.test(importPath))) {
        return rule.type;
      }
    }

    return null;
  }

  async collect(filePath: string, importPath: string, type: Module.Type): Promise<Module> {
    const content = await readFile(filePath);
    const hash = crypto.createHash("sha1").update(content).digest("hex");
    const fileName = this.#preserveFileNames
      ? path.basename(importPath)
      : `${hash}-${path.basename(importPath)}`;

    const module: Module = {
      name: fileName,
      path: filePath,
      content,
      type,
    };

    this.#modules[fileName] = module;
    return module;
  }

  async resolve(filePath: string, importPath: string): Promise<{
    fileName: string;
    content: Buffer;
    type: Module.Type;
  } | null> {
    const type = this.match(importPath);
    if (type === null) {
      return null;
    }

    const module = await this.collect(filePath, importPath, type);
    return {
      fileName: module.name,
      content: module.content,
      type: module.type,
    };
  }

  getModules(): ReadonlyArray<Module> {
    return Object.values(this.#modules);
  }
}
