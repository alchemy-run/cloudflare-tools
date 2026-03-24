/**
 * Additional Modules plugin.
 *
 * Handles non-JS imports (.wasm, .bin, .txt, .html, .sql) — intercepts them
 * during resolution, collects them, and ensures they appear in the output
 * as separate modules for the Workers multipart upload.
 *
 * @module
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createUnplugin } from "unplugin";
import type { ModuleRule } from "../config.js";
import { DEFAULT_MODULE_RULES } from "../config.js";
import type { AdditionalModule, ModuleType } from "../types.js";

export interface AdditionalModulesOptions {
  /** Module rules (merged with defaults) */
  readonly rules?: ReadonlyArray<ModuleRule>;
}

/**
 * Maps a module rule type to the Workers module type used in multipart upload.
 */
function ruleTypeToModuleType(ruleType: string): ModuleType {
  switch (ruleType) {
    case "CompiledWasm":
      return "CompiledWasm";
    case "Data":
      return "Data";
    case "Text":
      return "Text";
    default:
      return "Data";
  }
}

/**
 * Check if a file path matches a glob pattern (simple implementation).
 * Supports `**\/*.ext` patterns which is what module rules typically use.
 */
function matchesGlob(filePath: string, glob: string): boolean {
  // Handle ?query params in the glob (e.g. "**/*.wasm?module")
  const [globPath, globQuery] = glob.split("?");
  const [filePathClean, fileQuery] = filePath.split("?");

  // If glob has a query, file must match it
  if (globQuery !== undefined && fileQuery !== globQuery) {
    return false;
  }
  // If glob has no query but file does, don't match
  if (globQuery === undefined && fileQuery !== undefined) {
    return false;
  }

  // Simple glob matching: **/*.ext → check extension
  if (globPath!.startsWith("**/")) {
    const pattern = globPath!.slice(3); // Remove "**/"
    if (pattern.startsWith("*")) {
      // **/*.ext → match extension
      const ext = pattern.slice(1); // ".ext"
      return filePathClean!.endsWith(ext);
    }
    return basename(filePathClean!) === pattern;
  }

  // Direct match
  return filePathClean === globPath;
}

/**
 * Find the matching module rule for an import ID.
 */
function findMatchingRule(id: string, rules: ReadonlyArray<ModuleRule>): ModuleRule | undefined {
  for (const rule of rules) {
    for (const glob of rule.globs) {
      if (matchesGlob(id, glob)) {
        return rule;
      }
    }
  }
  return undefined;
}

/**
 * Create the additional modules plugin and return both the plugin
 * and a function to retrieve collected modules after the build.
 */
export function createAdditionalModulesCollector(options?: AdditionalModulesOptions) {
  const rules = [...DEFAULT_MODULE_RULES, ...(options?.rules ?? [])];
  const collected = new Map<string, AdditionalModule>();

  const plugin = createUnplugin((_options?: undefined) => ({
    name: "cloudflare-bundler:additional-modules",

    resolveId(id: string, importer: string | undefined) {
      const rule = findMatchingRule(id, rules);
      if (!rule) return null;

      // Resolve the file path relative to the importer
      let filePath: string;
      if (importer) {
        filePath = resolve(dirname(importer), id.split("?")[0]!);
      } else {
        filePath = resolve(id.split("?")[0]!);
      }

      // Read the file and hash it for a unique name
      const content = readFileSync(filePath);
      const hash = createHash("sha1").update(content).digest("hex");
      const originalName = basename(filePath);
      const hashedName = `${hash}-${originalName}`;

      const moduleType = ruleTypeToModuleType(rule.type);
      const moduleContent: string | Uint8Array =
        moduleType === "Text" ? content.toString("utf-8") : new Uint8Array(content);

      collected.set(hashedName, {
        name: hashedName,
        type: moduleType,
        content: moduleContent,
      });

      return { id: `./${hashedName}`, external: true };
    },
  }));

  return {
    plugin,
    getCollectedModules(): ReadonlyArray<AdditionalModule> {
      return [...collected.values()];
    },
  };
}
