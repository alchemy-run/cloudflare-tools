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
  readonly polyfill: ReadonlyArray<string>;
  readonly nodeModulePattern: RegExp;
}

export async function resolveUnenv(options: ResolveUnenvOptions = {}): Promise<UnenvResolution> {
  const { defineEnv } = await import("unenv");
  const { getCloudflarePreset, nonPrefixedNodeModules } = await import("@cloudflare/unenv-preset");

  const { alias, inject, external, polyfill } = defineEnv({
    presets: [
      getCloudflarePreset({
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: options.compatibilityFlags ? [...options.compatibilityFlags] : undefined,
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

  const nodeModulesPattern = nonPrefixedNodeModules
    .map((module) => module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  return {
    alias: resolvedAlias,
    inject,
    external,
    polyfill,
    nodeModulePattern: new RegExp(`^(node:)?(${nodeModulesPattern})$`),
  };
}
