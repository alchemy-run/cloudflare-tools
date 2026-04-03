import { getCloudflarePreset, nonPrefixedNodeModules } from "@cloudflare/unenv-preset";
import assert from "node:assert";
import type { Plugin, RolldownPluginOption } from "rolldown";
import { esmExternalRequirePlugin } from "rolldown/plugins";
import { defineEnv } from "unenv";
import type { CloudflarePluginOptions } from "../plugin.js";
import { hasNodejsCompat } from "../utils.js";

const NODE_BUILTIN_MODULES_REGEXP = new RegExp(`^(${nonPrefixedNodeModules.join("|")}|node:.+)$`);

export function makeNodejsCompatPlugin(options: CloudflarePluginOptions): RolldownPluginOption {
  if (hasNodejsCompat(options.compatibilityFlags)) {
    return makeUnenvPlugin(options);
  }
  return makeNodeJsImportWarningPlugin();
}

function makeUnenvPlugin(options: CloudflarePluginOptions): RolldownPluginOption {
  const { alias, inject, external, polyfill } = defineEnv({
    presets: [
      getCloudflarePreset({
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: options.compatibilityFlags,
      }),
    ],
  }).env;

  const injectVirtualModules = makeInjectVirtualModules(inject);

  return [
    esmExternalRequirePlugin({
      external: [...external],
      skipDuplicateCheck: true,
    }),
    {
      name: "rolldown-plugin-cloudflare:nodejs-compat:injects",
      load: {
        filter: { id: Object.keys(injectVirtualModules) },
        handler(id) {
          return injectVirtualModules.get(id);
        },
      },
    },
    {
      name: "rolldown-plugin-cloudflare:nodejs-compat",
      resolveId: {
        filter: { id: NODE_BUILTIN_MODULES_REGEXP },
        handler(source, importer, options) {
          const aliased = alias[source];
          if (!aliased) {
            return;
          }
          if (external.includes(aliased)) {
            return {
              id: aliased,
              external: true,
            };
          }
          return this.resolve(aliased, importer, options);
        },
      },
      transform(code, id) {
        const info = this.getModuleInfo(id);
        if (!info?.isEntry) {
          return;
        }
        return [
          ...polyfill.map((module) => `import "${module}";`),
          ...Object.keys(injectVirtualModules).map((module) => `import "${module}";`),
          code,
        ].join("\n");
      },
    } satisfies Plugin,
  ];
}

function makeNodeJsImportWarningPlugin(): RolldownPluginOption {
  const imports = new Map<string, Set<string>>();
  return {
    name: "rolldown-plugin-cloudflare:nodejs-compat:import-warnings",
    resolveId: {
      filter: { id: NODE_BUILTIN_MODULES_REGEXP },
      async handler(id, importer, options) {
        const resolved = await this.resolve(id, importer, options);
        if (!resolved) {
          if (importer) {
            if (!imports.has(id)) {
              imports.set(id, new Set());
            }
            imports.get(id)?.add(importer);
          }
          return { id, external: true };
        }
      },
    },
    buildStart() {
      imports.clear();
    },
    buildEnd() {
      if (imports.size > 0) {
        for (const [id, importers] of imports.entries()) {
          this.warn(
            [
              `Node.js built-in module "${id}" was imported without \`nodejs_compat\`. Imported from:`,
              ...Array.from(importers).map((importer) => `- ${importer}`),
            ].join("\n"),
          );
        }
      }
    },
  };
}

function makeInjectVirtualModules(
  inject: Readonly<Record<string, string | ReadonlyArray<string>>>,
) {
  const virtualModules = new Map<string, string>();
  for (const [injectedName, moduleSpecifier] of Object.entries(inject)) {
    // The type from unenv is string | string[], but the Cloudflare preset only uses string.
    // This indicates a default export that we set on globalThis.
    assert(typeof moduleSpecifier === "string", `expected moduleSpecifier to be a string`);
    virtualModules.set(
      injectVirtualModuleId(injectedName),
      `import virtualModule from "${moduleSpecifier}"; globalThis.${injectedName} = virtualModule;`,
    );
  }
  return virtualModules;
}

function injectVirtualModuleId(module: string) {
  return `virtual:nodejs-global-inject/${module}` as const;
}
