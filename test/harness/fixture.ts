/**
 * Fixture loading utilities.
 *
 * Parses wrangler.jsonc files from test fixtures and produces BundleConfig
 * objects that can be passed to any BundlerAdapter.
 */
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Rule } from "../../src/module-rules.js";
import type { BundleConfig, DurableObjectBinding } from "./types.js";

/**
 * Returns the absolute path to a fixture directory.
 */
export function fixtureDir(fixtureName: string): string {
  return path.resolve(import.meta.dirname, "..", "fixtures", fixtureName);
}

/**
 * Loads a fixture's wrangler.jsonc and produces a BundleConfig.
 *
 * Searches for wrangler.jsonc, wrangler.json, or wrangler.toml (jsonc/json only
 * for now — toml parsing is not implemented).
 */
export function loadFixture(fixtureName: string): Effect.Effect<BundleConfig> {
  return Effect.sync(() => {
    const root = fixtureDir(fixtureName);

    // Find the config file
    const configPath = resolveConfigPath(root);
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = parseJsonc(raw);

    // Resolve the entry point
    const main = config.main as string | undefined;
    if (!main) {
      throw new Error(`Fixture "${fixtureName}" wrangler config is missing "main" field`);
    }
    const entryPoint = path.resolve(root, main);

    // Extract compatibility settings
    const compatibilityDate = (config.compatibility_date as string) ?? "2025-01-01";
    const compatibilityFlags = (config.compatibility_flags as Array<string>) ?? [];

    // Extract module rules
    const rules = config.rules as Array<Rule> | undefined;

    // Extract durable object bindings
    const doConfig = config.durable_objects as
      | { bindings?: Array<DurableObjectBinding> }
      | undefined;
    const durableObjects = doConfig?.bindings;

    return {
      entryPoint,
      projectRoot: root,
      compatibilityDate,
      compatibilityFlags,
      define: config.define as Record<string, string> | undefined,
      rules,
      findAdditionalModules: config.find_additional_modules as boolean | undefined,
      preserveFileNames: config.preserve_file_names as boolean | undefined,
      external: config.external as Array<string> | undefined,
      durableObjects,
      minify: config.minify as boolean | undefined,
      keepNames: config.keep_names as boolean | undefined,
      tsconfig: config.tsconfig as string | undefined,
    } satisfies BundleConfig;
  });
}

/**
 * Resolves the wrangler config file path within a fixture directory.
 * Tries wrangler.jsonc, then wrangler.json.
 */
function resolveConfigPath(fixtureRoot: string): string {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const p = path.join(fixtureRoot, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No wrangler.jsonc or wrangler.json found in ${fixtureRoot}`);
}

/**
 * Parses a JSONC (JSON with comments) string.
 * Strips single-line (//) and multi-line comments, then parses as JSON.
 */
function parseJsonc(text: string): Record<string, unknown> {
  // Remove single-line comments (// ...)
  // Be careful not to strip // inside strings
  let result = "";
  let inString = false;
  let isEscape = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;

    if (isEscape) {
      result += char;
      isEscape = false;
      i++;
      continue;
    }

    if (char === "\\") {
      result += char;
      isEscape = true;
      i++;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = !inString;
      i++;
      continue;
    }

    if (!inString) {
      // Single-line comment
      if (char === "/" && text[i + 1] === "/") {
        // Skip to end of line
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      // Multi-line comment
      if (char === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i - 1] === "*" && text[i] === "/")) i++;
        i++; // skip closing /
        continue;
      }
      // Trailing commas: replace comma followed by } or ]
      if (char === ",") {
        // Look ahead past whitespace for } or ]
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (text[j] === "}" || text[j] === "]") {
          i++;
          continue; // skip the trailing comma
        }
      }
    }

    result += char;
    i++;
  }

  return JSON.parse(result) as Record<string, unknown>;
}
