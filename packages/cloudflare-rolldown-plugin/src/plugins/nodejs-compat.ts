import { getCloudflarePreset, nonPrefixedNodeModules } from "@cloudflare/unenv-preset";
import assert from "node:assert";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "rolldown";
import { esmExternalRequirePlugin } from "rolldown/plugins";
import { defineEnv } from "unenv";
import type { CloudflarePluginOptions } from "../plugin.js";
import { hasNodejsCompat } from "../utils.js";

const NODE_BUILTIN_MODULES_REGEXP = new RegExp(`^(${nonPrefixedNodeModules.join("|")}|node:.+)$`);
const VIRTUAL_MODULE_ID_REGEXP = /^virtual:nodejs-global-inject\/.+$/;

export function makeNodejsCompatPlugin(options: CloudflarePluginOptions): Plugin | Array<Plugin> {
  if (hasNodejsCompat(options.compatibilityFlags)) {
    return makeUnenvPlugin(options);
  }
  return makeNodeJsImportWarningPlugin();
}

function makeUnenvPlugin(options: CloudflarePluginOptions): Array<Plugin> {
  const { alias, inject, external, polyfill } = defineEnv({
    presets: [
      getCloudflarePreset({
        compatibilityDate: options.compatibilityDate,
        compatibilityFlags: options.compatibilityFlags,
      }),
    ],
  }).env;

  const injectVirtualModules = makeInjectVirtualModules(inject);
  const require = createRequire(import.meta.url);

  return [
    esmExternalRequirePlugin({
      external: [...external],
      skipDuplicateCheck: true,
    }),
    {
      name: "rolldown-plugin-cloudflare:nodejs-compat:injects",
      resolveId: {
        filter: { id: VIRTUAL_MODULE_ID_REGEXP },
        handler(id) {
          if (injectVirtualModules.has(id)) {
            return { id };
          }
        },
      },
      load: {
        filter: { id: VIRTUAL_MODULE_ID_REGEXP },
        handler(id) {
          return injectVirtualModules.get(id);
        },
      },
    },
    {
      name: "rolldown-plugin-cloudflare:nodejs-compat:unenv-preset-imports",
      resolveId: {
        filter: { id: /^@cloudflare\/unenv-preset\// },
        async handler(id, importer, options) {
          const resolved = await this.resolve(id, importer, options);
          if (resolved) return resolved;
          return { id: require.resolve(id) };
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
          ...Array.from(injectVirtualModules.keys()).map((module) => `import "${module}";`),
          code,
        ].join("\n");
      },
    } satisfies Plugin,
  ];
}

function makeNodeJsImportWarningPlugin(): Plugin {
  const imports = new Map<string, Set<string>>();
  let root = process.cwd();
  return {
    name: "rolldown-plugin-cloudflare:nodejs-import-warnings",
    options(options) {
      if (options.cwd) {
        root = options.cwd;
      }
    },
    resolveId: {
      filter: { id: NODE_BUILTIN_MODULES_REGEXP },
      async handler(id, importer) {
        if (importer) {
          if (!imports.has(id)) {
            imports.set(id, new Set());
          }
          imports.get(id)?.add(importer);
        }
        return { id, external: true };
      },
    },
    buildStart() {
      imports.clear();
    },
    buildEnd() {
      if (imports.size > 0) {
        let message =
          `Unexpected Node.js imports. ` +
          `Do you need to enable the "nodejs_compat" compatibility flag? ` +
          "Refer to https://developers.cloudflare.com/workers/runtime-apis/nodejs/ for more details.\n";
        for (const [id, importers] of imports.entries()) {
          for (const importer of importers) {
            message += ` - "${id}" imported from "${path.relative(root, importer)}"\n`;
          }
        }
        this.warn(message);
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
