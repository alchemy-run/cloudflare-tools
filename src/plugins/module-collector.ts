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
import type { Plugin } from "esbuild";
import globToRegExp from "glob-to-regexp";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Module } from "../module.js";

export interface ModuleCollectorOptions {
  /** Module rules (user-defined + defaults will be merged) */
  readonly rules?: ReadonlyArray<Rule>;
  /** Whether to preserve original filenames instead of hashing */
  readonly preserveFileNames?: boolean;
}

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
 * Creates a module collector — an esbuild plugin + mutable modules array.
 *
 * Usage:
 * ```ts
 * const collector = createModuleCollector({ rules });
 * // Pass collector.plugin to esbuild plugins array
 * // After build, read collector.modules for collected WASM/text/data modules
 * ```
 */
export function createModuleCollector(options: ModuleCollectorOptions = {}) {
  let modules: Record<string, Module> = {};
  const parsedRules = parseRules(options.rules);
  const preserveFileNames = options.preserveFileNames ?? false;

  const plugin: Plugin = {
    name: "distilled-module-collector",
    setup(build) {
      // Reset modules at the start of each build (for watch mode)
      build.onStart(() => {
        modules = {};
      });

      // Register an onResolve handler for each rule + glob combination
      for (const rule of parsedRules) {
        // Skip JavaScript rules — let esbuild bundle those normally
        if (rule.type === "ESModule" || rule.type === "CommonJS") {
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
            const fileHash = crypto.createHash("sha1").update(fileContent).digest("hex");

            // Determine the output filename (no ./ prefix — just the hashed basename)
            const fileName = preserveFileNames
              ? path.basename(args.path)
              : `${fileHash}-${path.basename(args.path)}`;

            // Record the module
            modules[fileName] = {
              name: fileName,
              path: filePath,
              content: fileContent,
              type: rule.type,
            };

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

  return { getModules: () => Object.values(modules), plugin };
}

/**
 * Default module rules matching Cloudflare Workers conventions.
 *
 * - `.txt`, `.html`, `.sql` → Text modules
 * - `.bin` → Data (binary) modules
 * - `.wasm`, `.wasm?module` → CompiledWasm modules
 */
const DEFAULT_MODULE_RULES: Array<Rule> = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

/**
 * Parses user-defined module rules, merges them with defaults,
 * and handles fallthrough semantics.
 *
 * Rules without `fallthrough: true` "complete" their type — any
 * subsequent rules of the same type are marked as removed.
 *
 * Port of wrangler's deployment-bundle/rules.ts — defines the default
 * module rules for Cloudflare Workers and handles rule merging with
 * fallthrough semantics.
 */
function parseRules(userRules: ReadonlyArray<Rule> = []): ReadonlyArray<Rule> {
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
