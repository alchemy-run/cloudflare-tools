import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface ResolveUnenvOptions {
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: ReadonlyArray<string>;
}

export interface UnenvResolution {
  readonly alias: Record<
    string,
    {
      readonly resolvedPath: string;
      readonly source: string;
    }
  >;
  readonly inject: Record<string, string | ReadonlyArray<string>>;
  readonly external: ReadonlyArray<string>;
  readonly entries: ReadonlyMap<string, string>;
  readonly polyfill: ReadonlyArray<string>;
  readonly nodeModulePattern: RegExp;
  readonly resolveImport: (source: string) =>
    | {
        readonly id: string;
        readonly external: boolean;
      }
    | undefined;
}

export async function resolveUnenv(options: ResolveUnenvOptions = {}): Promise<UnenvResolution> {
  const { defineEnv } = await import("unenv");
  const { getCloudflarePreset, nonPrefixedNodeModules } = await import("@cloudflare/unenv-preset");

  const { alias, inject, external, polyfill } = defineEnv({
    presets: [
      getCloudflarePreset({
        ...(options.compatibilityDate ? { compatibilityDate: options.compatibilityDate } : {}),
        ...(options.compatibilityFlags
          ? { compatibilityFlags: [...options.compatibilityFlags] }
          : {}),
      }),
      {
        alias: {
          // Force the node implementation of debug.
          debug: "debug",
        },
      },
    ],
    npmShims: true,
  }).env;

  const resolvedAlias: UnenvResolution["alias"] = {};
  for (const [module, unresolvedAlias] of Object.entries(alias)) {
    try {
      resolvedAlias[module] = {
        resolvedPath: require.resolve(unresolvedAlias),
        source: unresolvedAlias,
      };
    } catch {
      // Package not installed, skip the alias.
    }
  }

  const externalSet = new Set(external);
  const entries = new Map<string, string>();
  const addEntry = (source: string) => {
    if (externalSet.has(source) || entries.has(source)) {
      return;
    }

    try {
      entries.set(source, require.resolve(source));
    } catch {
      // Package not installed, skip the entry.
    }
  };

  for (const { source } of Object.values(resolvedAlias)) {
    addEntry(source);
  }

  for (const value of Object.values(inject)) {
    addEntry(typeof value === "string" ? value : (value[0] as string));
  }

  for (const moduleId of polyfill) {
    addEntry(moduleId);
  }

  const nodeModulesPattern = nonPrefixedNodeModules
    .map((module) => module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  return {
    alias: resolvedAlias,
    entries,
    inject,
    external,
    polyfill,
    nodeModulePattern: new RegExp(`^(${nodeModulesPattern}|node:.+)$`),
    resolveImport: (source) => {
      const alias = resolvedAlias[source];
      if (alias) {
        return {
          id: alias.resolvedPath,
          external: externalSet.has(alias.source),
        };
      }

      const entry = entries.get(source);
      if (entry) {
        return {
          id: entry,
          external: false,
        };
      }

      if (externalSet.has(source)) {
        return {
          id: source,
          external: true,
        };
      }
    },
  };
}
