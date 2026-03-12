/**
 * esbuild plugin for Node.js compatibility in Cloudflare Workers.
 *
 * Uses `unenv` and `@cloudflare/unenv-preset` to determine how Node.js
 * built-in modules should be handled:
 * - Native modules (buffer, crypto, etc.) are externalized
 * - Hybrid modules (process, console, etc.) are polyfilled inline
 * - Node.js globals (process, Buffer) are injected
 *
 * Port of wrangler's hybrid-nodejs-compat.ts.
 */
import path from "node:path";
import type { Plugin } from "esbuild";

/**
 * Virtual namespace for converting CJS require() of Node.js builtins to ESM.
 */
const REQUIRED_NODE_BUILT_IN_NAMESPACE = "node-built-in-modules";

/**
 * Virtual namespace for CJS require() of unenv-aliased npm packages.
 */
const REQUIRED_UNENV_ALIAS_NAMESPACE = "required-unenv-alias";

/**
 * Prefix for virtual global polyfill modules.
 */
const VIRTUAL_POLYFILL_PREFIX = "_virtual_unenv_global_polyfill-";

/**
 * Regex to match virtual polyfill module paths.
 */
const VIRTUAL_POLYFILL_RE = new RegExp(
  `${VIRTUAL_POLYFILL_PREFIX.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(.+)$`,
);

export interface NodejsCompatOptions {
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: ReadonlyArray<string>;
}

/**
 * Creates the Node.js compatibility plugin.
 *
 * Dynamically imports `unenv` and `@cloudflare/unenv-preset` (ESM-only packages)
 * to determine how Node.js modules should be handled for the given compatibility
 * date and flags.
 */
export function nodejsCompatPlugin(options: NodejsCompatOptions = {}): Plugin {
  return {
    name: "distilled-nodejs-compat",
    async setup(build) {
      // Dynamically import ESM-only packages
      const { defineEnv } = await import("unenv");
      const { getCloudflarePreset, nonPrefixedNodeModules } =
        await import("@cloudflare/unenv-preset");

      // Get the resolved environment configuration
      const { alias, inject, external, polyfill } = defineEnv({
        presets: [
          getCloudflarePreset({
            compatibilityDate: options.compatibilityDate,
            compatibilityFlags: options.compatibilityFlags
              ? [...options.compatibilityFlags]
              : undefined,
          }),
          {
            alias: {
              // Force esbuild to use node implementation of debug
              debug: "debug",
            },
          },
        ],
        npmShims: true,
      }).env;

      // Build regex to match all Node.js module specifiers
      const nodeModulesPattern = nonPrefixedNodeModules
        .map((m: string) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      const nodeJsModuleRegexp = new RegExp(`^(node:)?(${nodeModulesPattern})$`);

      // --- Handler 1: Convert CJS require() of Node.js builtins to ESM ---
      handleRequireCallsToNodeJSBuiltins(build, nodeJsModuleRegexp);

      // --- Handler 2: Resolve unenv aliases + externalize native modules ---
      handleUnenvAliasedPackages(build, alias, external);

      // --- Handler 3: Inject Node.js globals (process, Buffer, etc.) ---
      handleNodeJSGlobals(build, inject, polyfill);
    },
  };
}

/**
 * Converts CJS `require('node:...')` calls to ESM by routing through a virtual
 * namespace that wraps the import.
 */
function handleRequireCallsToNodeJSBuiltins(
  build: Parameters<Plugin["setup"]>[0],
  nodeJsModuleRegexp: RegExp,
): void {
  build.onResolve({ filter: nodeJsModuleRegexp }, (args) => {
    if (args.kind === "require-call") {
      return {
        path: args.path,
        namespace: REQUIRED_NODE_BUILT_IN_NAMESPACE,
      };
    }
    return undefined;
  });

  build.onLoad(
    { filter: /.*/, namespace: REQUIRED_NODE_BUILT_IN_NAMESPACE },
    ({ path: modulePath }) => {
      return {
        contents: [`import libDefault from '${modulePath}';`, `module.exports = libDefault;`].join(
          "\n",
        ),
        loader: "js",
      };
    },
  );
}

/**
 * Resolves unenv alias mappings and handles CJS require of aliased npm packages.
 */
function handleUnenvAliasedPackages(
  build: Parameters<Plugin["setup"]>[0],
  alias: Record<string, string>,
  external: ReadonlyArray<string>,
): void {
  // Resolve all aliases to absolute paths
  const aliasAbsolute: Record<string, string> = {};
  for (const [module, unresolvedAlias] of Object.entries(alias)) {
    try {
      aliasAbsolute[module] = require.resolve(unresolvedAlias);
    } catch {
      // Package not installed, skip
    }
  }

  // Build regex matching all alias keys
  const aliasKeys = Object.keys(aliasAbsolute);
  if (aliasKeys.length === 0) return;

  const aliasPattern = aliasKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const aliasRegexp = new RegExp(`^(${aliasPattern})$`);

  build.onResolve({ filter: aliasRegexp }, (args) => {
    const unresolvedAlias = alias[args.path];

    // Handle CJS require() of unenv npm shims
    if (
      args.kind === "require-call" &&
      unresolvedAlias &&
      (unresolvedAlias.startsWith("unenv/npm/") || unresolvedAlias.startsWith("unenv/mock/"))
    ) {
      return {
        path: args.path,
        namespace: REQUIRED_UNENV_ALIAS_NAMESPACE,
      };
    }

    // Resolve to absolute path and mark as external if appropriate
    const resolvedPath = aliasAbsolute[args.path];
    if (resolvedPath && unresolvedAlias) {
      return {
        path: resolvedPath,
        external: external.includes(unresolvedAlias),
      };
    }

    return undefined;
  });

  build.onLoad(
    { filter: /.*/, namespace: REQUIRED_UNENV_ALIAS_NAMESPACE },
    ({ path: modulePath }) => {
      return {
        contents: [
          `import * as esm from '${modulePath}';`,
          `module.exports = Object.entries(esm)`,
          `  .filter(([k,]) => k !== 'default')`,
          `  .reduce((cjs, [k, value]) =>`,
          `    Object.defineProperty(cjs, k, { value, enumerable: true }),`,
          `    "default" in esm ? esm.default : {}`,
          `  );`,
        ].join("\n"),
        loader: "js",
      };
    },
  );
}

/**
 * Injects Node.js global polyfills (process, Buffer, etc.) via esbuild's
 * inject mechanism using virtual modules.
 */
function handleNodeJSGlobals(
  build: Parameters<Plugin["setup"]>[0],
  inject: Record<string, string | ReadonlyArray<string>>,
  polyfill: ReadonlyArray<string>,
): void {
  // Parse the inject map into grouped data structures
  interface InjectedGlobal {
    injectedName: string;
    exportName: string;
    importName: string;
  }

  const injectsByModule = new Map<string, Array<InjectedGlobal>>();

  for (const [injectedName, value] of Object.entries(inject)) {
    if (!value) continue;

    let module: string;
    let exportName: string;
    let importName: string;

    if (typeof value === "string") {
      module = value;
      exportName = "default";
      importName = "defaultExport";
    } else {
      module = value[0] as string;
      exportName = value[1] as string;
      importName = exportName;
    }

    const existing = injectsByModule.get(module) ?? [];
    existing.push({ injectedName, exportName, importName });
    injectsByModule.set(module, existing);
  }

  // Use import.meta.dirname as the base path for virtual module anchoring
  const prefix = path.resolve(import.meta.dirname, VIRTUAL_POLYFILL_PREFIX);

  // Map virtual module paths to their source module specifiers
  const virtualModulePathToSpecifier = new Map<string, string>();
  for (const [moduleSpecifier] of injectsByModule) {
    const sanitized = moduleSpecifier.replaceAll("/", "-");
    const virtualPath = prefix + sanitized;
    virtualModulePathToSpecifier.set(virtualPath, moduleSpecifier);
  }

  // Mutate esbuild's inject option to include our virtual modules + polyfills
  build.initialOptions.inject = [
    ...(build.initialOptions.inject ?? []),
    ...virtualModulePathToSpecifier.keys(),
    ...polyfill.map((m) => {
      try {
        return require.resolve(m);
      } catch {
        return m;
      }
    }),
  ];

  // Resolve virtual polyfill paths — tell esbuild they exist as-is
  build.onResolve({ filter: VIRTUAL_POLYFILL_RE }, ({ path: p }) => {
    return { path: p };
  });

  // Load virtual polyfill modules — generate code that assigns globals
  build.onLoad({ filter: VIRTUAL_POLYFILL_RE }, ({ path: p }) => {
    const moduleSpecifier = virtualModulePathToSpecifier.get(p);
    if (!moduleSpecifier) return undefined;

    const globals = injectsByModule.get(moduleSpecifier);
    if (!globals) return undefined;

    const lines: Array<string> = [];

    // Build import statement
    const imports = globals.map((g) =>
      g.exportName === "default"
        ? `default as ${g.importName}`
        : `${g.exportName} as ${g.importName}`,
    );
    lines.push(`import { ${imports.join(", ")} } from "${moduleSpecifier}";`);

    // Build global assignments
    for (const g of globals) {
      lines.push(`globalThis.${g.injectedName} = ${g.importName};`);
    }

    return {
      contents: lines.join("\n"),
      loader: "js",
    };
  });
}
