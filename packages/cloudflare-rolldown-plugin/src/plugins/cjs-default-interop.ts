import type { PluginContext } from "rolldown";
import { createPlugin } from "../factory.js";

// Virtual-module prefix for the ESM shim we generate around TS-compiled CJS
// modules. Using a `\0` prefix follows the standard rolldown/rollup convention
// for virtual modules so other plugins don't try to resolve / load it from disk.
// oxlint-disable-next-line no-control-regex
const VIRTUAL_PREFIX = "\0distilled:cjs-default-fix:";
// oxlint-disable-next-line no-control-regex
const VIRTUAL_REGEX = /^\0distilled:cjs-default-fix:/;

const ES_MODULE_MARKER_REGEX =
  /Object\.defineProperty\(\s*exports\s*,\s*["']__esModule["']|\bexports\.__esModule\s*=/;
const DEFAULT_EXPORT_REGEX = /\b(?:module\.)?exports\.default\s*=/;
// Detect `module.exports = X` where X is not a brace literal and not the local
// `exports` object. Packages like `@databases/sql` set `module.exports = sql`
// (the function itself), and in that case Rolldown's existing CJS interop
// already produces the right default — we should leave such modules alone.
const MODULE_EXPORTS_REASSIGN_REGEX = /\bmodule\.exports\s*=\s*(?!\s*\{|\s*exports\b)/;

const NAMED_EXPORT_ASSIGN_REGEX = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
const NAMED_EXPORT_DEFINE_REGEX =
  /Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*["']([A-Za-z_$][\w$]*)["']/g;

/**
 * Rewrites TS-compiled CJS modules (those that set both `__esModule: true`
 * **and** `exports.default = X`) into an ESM shim whose default export is the
 * "Babel/TypeScript" interpretation — i.e. `module.exports.default` — rather
 * than the entire `module.exports` object.
 *
 * Background: when an ESM file in a `"type": "module"` package imports a
 * default from such a CJS module, Rolldown's CJS interop heuristic resolves
 * the default to the whole `module.exports` value (the Node-native
 * interpretation). For modules whose `module.exports` is an *object* with a
 * separate `default` key, that means `import foo from "x"` gives you
 * `{ __esModule: true, default: foo, ... }` instead of `foo`, and calling it
 * as a function blows up at runtime. This pattern is extremely common in
 * older TypeScript-compiled CJS packages (e.g. `@databases/validate-unicode`).
 *
 * The shim imports the original CJS module twice — once as default to get the
 * raw `module.exports` value, and once as named imports for each statically
 * detectable property — then re-exports a `default` that handles both
 * interop interpretations.
 *
 * See https://rolldown.rs/in-depth/bundling-cjs#ambiguous-default-import-from-cjs-modules
 * for the underlying heuristic.
 */
export const cjsDefaultInteropPlugin = createPlugin("cjs-default-interop", () => {
  const shimCache = new Map<string, Promise<string | null>>();
  function getShimCached(
    this: Pick<PluginContext, "fs">,
    originalId: string,
  ): Promise<string | null> {
    const cached = shimCache.get(originalId);
    if (cached !== undefined) return cached;
    const shim = getShim.call(this, originalId);
    shimCache.set(originalId, shim);
    return shim;
  }
  return {
    shared: {
      resolveId: {
        async handler(source, importer, options) {
          if (importer && VIRTUAL_REGEX.test(importer)) return;
          if (options.kind !== "import-statement" && options.kind !== "dynamic-import") return;
          const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
          if (!resolved || resolved.external) return resolved;
          if (!resolved.id.includes("/node_modules/")) return resolved;
          if (!/\.c?js$/.test(resolved.id)) return resolved;
          const shim = await getShimCached.call(this, resolved.id);
          if (!shim) return resolved;
          return { id: `${VIRTUAL_PREFIX}${resolved.id}` };
        },
      },
      load: {
        filter: { id: VIRTUAL_REGEX },
        async handler(id) {
          const originalId = id.slice(VIRTUAL_PREFIX.length);
          return await getShimCached.call(this, originalId);
        },
      },
    },
  };
});

async function getShim(
  this: Pick<PluginContext, "fs">,
  originalId: string,
): Promise<string | null> {
  let code: string;
  try {
    code = await this.fs.readFile(originalId, { encoding: "utf8" });
  } catch {
    return null;
  }
  if (!isTsCompiledCjsWithDefault(code)) {
    return null;
  }
  const importPath = JSON.stringify(originalId);
  const namedExports = extractNamedExports(code);
  return [
    `import __cjs from ${importPath};`,
    ...namedExports.map((name) => `import { ${name} as __${name} } from ${importPath};`),
    `const __resolved = (__cjs && typeof __cjs === "object" && __cjs.__esModule === true && "default" in __cjs) ? __cjs.default : __cjs;`,
    `export default __resolved;`,
    ...namedExports.map((name) => `export const ${name} = __${name};`),
  ].join("\n");
}

function isTsCompiledCjsWithDefault(code: string): boolean {
  return (
    ES_MODULE_MARKER_REGEX.test(code) &&
    DEFAULT_EXPORT_REGEX.test(code) &&
    !MODULE_EXPORTS_REASSIGN_REGEX.test(code)
  );
}

function extractNamedExports(code: string): Array<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(NAMED_EXPORT_ASSIGN_REGEX)) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(NAMED_EXPORT_DEFINE_REGEX)) {
    names.add(match[1]);
  }
  names.delete("default");
  names.delete("__esModule");
  return [...names];
}
