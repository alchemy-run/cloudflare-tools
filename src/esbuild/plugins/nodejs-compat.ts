/**
 * esbuild plugin for Node.js compatibility in Cloudflare Workers.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "esbuild";
import { resolveUnenv, type ResolveUnenvOptions } from "../../nodejs-compat-env.js";

const require = createRequire(import.meta.url);

const REQUIRED_NODE_BUILT_IN_NAMESPACE = "node-built-in-modules";
const REQUIRED_UNENV_ALIAS_NAMESPACE = "required-unenv-alias";
const VIRTUAL_POLYFILL_PREFIX = "_virtual_unenv_global_polyfill-";
const VIRTUAL_POLYFILL_RE = new RegExp(
  `${VIRTUAL_POLYFILL_PREFIX.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(.+)$`,
);

export interface NodejsCompatOptions extends ResolveUnenvOptions {}

export function nodejsCompatPlugin(options: NodejsCompatOptions = {}): Plugin {
  return {
    name: "distilled-nodejs-compat",
    async setup(build) {
      const env = await resolveUnenv(options);

      handleRequireCallsToNodeJSBuiltins(build, env.nodeModulePattern);
      handleUnenvAliasedPackages(build, env.alias, env.external);
      handleNodeJSGlobals(build, env.inject, env.polyfill);
    },
  };
}

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

  build.onLoad({ filter: /.*/, namespace: REQUIRED_NODE_BUILT_IN_NAMESPACE }, ({ path: modulePath }) => {
    return {
      contents: [`import libDefault from '${modulePath}';`, `module.exports = libDefault;`].join("\n"),
      loader: "js",
    };
  });
}

function handleUnenvAliasedPackages(
  build: Parameters<Plugin["setup"]>[0],
  alias: Awaited<ReturnType<typeof resolveUnenv>>["alias"],
  external: ReadonlyArray<string>,
): void {
  const aliasKeys = Object.keys(alias);
  if (aliasKeys.length === 0) return;

  const aliasPattern = aliasKeys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const aliasRegexp = new RegExp(`^(${aliasPattern})$`);

  build.onResolve({ filter: aliasRegexp }, (args) => {
    const resolvedAlias = alias[args.path];

    if (
      args.kind === "require-call" &&
      resolvedAlias &&
      (resolvedAlias.source.startsWith("unenv/npm/") || resolvedAlias.source.startsWith("unenv/mock/"))
    ) {
      return {
        path: args.path,
        namespace: REQUIRED_UNENV_ALIAS_NAMESPACE,
      };
    }

    if (resolvedAlias) {
      return {
        path: resolvedAlias.resolvedPath,
        external: external.includes(resolvedAlias.source),
      };
    }

    return undefined;
  });

  build.onLoad({ filter: /.*/, namespace: REQUIRED_UNENV_ALIAS_NAMESPACE }, ({ path: modulePath }) => {
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
  });
}

function handleNodeJSGlobals(
  build: Parameters<Plugin["setup"]>[0],
  inject: Record<string, string | ReadonlyArray<string>>,
  polyfill: ReadonlyArray<string>,
): void {
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

  const prefix = path.resolve(import.meta.dirname, VIRTUAL_POLYFILL_PREFIX);
  const virtualModulePathToSpecifier = new Map<string, string>();
  for (const [moduleSpecifier] of injectsByModule) {
    const sanitized = moduleSpecifier.replaceAll("/", "-");
    const virtualPath = prefix + sanitized;
    virtualModulePathToSpecifier.set(virtualPath, moduleSpecifier);
  }

  build.initialOptions.inject = [
    ...(build.initialOptions.inject ?? []),
    ...virtualModulePathToSpecifier.keys(),
    ...polyfill.map((module) => {
      try {
        return require.resolve(module);
      } catch {
        return module;
      }
    }),
  ];

  build.onResolve({ filter: VIRTUAL_POLYFILL_RE }, ({ path: virtualPath }) => {
    return { path: virtualPath };
  });

  build.onLoad({ filter: VIRTUAL_POLYFILL_RE }, ({ path: virtualPath }) => {
    const moduleSpecifier = virtualModulePathToSpecifier.get(virtualPath);
    if (!moduleSpecifier) return undefined;

    const globals = injectsByModule.get(moduleSpecifier);
    if (!globals) return undefined;

    const imports = globals.map((global) =>
      global.exportName === "default"
        ? `default as ${global.importName}`
        : `${global.exportName} as ${global.importName}`,
    );

    const lines = [`import { ${imports.join(", ")} } from "${moduleSpecifier}";`];
    for (const global of globals) {
      lines.push(`globalThis.${global.injectedName} = ${global.importName};`);
    }

    return {
      contents: lines.join("\n"),
      loader: "js",
    };
  });
}
