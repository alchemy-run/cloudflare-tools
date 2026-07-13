import { createPlugin } from "../factory.js";
import { resolvePluginApi } from "../utils.js";
import type { UnenvApi } from "./nodejs-compat.js";

// oxlint-disable-next-line no-control-regex
const VIRTUAL_MODULE_REGEXP = /^\0distilled:.*$/;

export const WORKER_ENTRY_PREFIX = "\0distilled:worker-entry:" as const;
const USER_ENTRY_PREFIX = "\0distilled:user-entry:" as const;
const INJECT_PREFIX = "\0distilled:inject:" as const;
const EXPORT_TYPES_ID = "\0distilled:export-types" as const;

export const virtualModulesPlugin = createPlugin("virtual-modules", (options) => {
  let unenvApi: UnenvApi | undefined;
  const inject = () => {
    if (!unenvApi) return [];
    return [
      ...unenvApi.polyfill.map((module) => `import "${module}";`),
      ...Object.keys(unenvApi.inject).map(
        (injectedName) => `import "${INJECT_PREFIX}${injectedName}";`,
      ),
    ];
  };
  return {
    vite: {
      enforce: "pre",
    },
    shared: {
      buildStart({ plugins }) {
        unenvApi = resolvePluginApi<UnenvApi>(plugins, "distilled-cloudflare:nodejs-unenv");
      },
      resolveId: {
        filter: { id: VIRTUAL_MODULE_REGEXP },
        handler(id) {
          if (
            id.startsWith(WORKER_ENTRY_PREFIX) ||
            id.startsWith(INJECT_PREFIX) ||
            id === EXPORT_TYPES_ID
          ) {
            return { id };
          }
          if (id.startsWith(USER_ENTRY_PREFIX)) {
            return this.resolve(id.slice(USER_ENTRY_PREFIX.length), undefined, {
              isEntry: true,
              kind: "import-statement",
            });
          }
        },
      },
      load: {
        filter: { id: VIRTUAL_MODULE_REGEXP },
        handler(id) {
          if (id.startsWith(WORKER_ENTRY_PREFIX)) {
            const userEntryId = id.replace(WORKER_ENTRY_PREFIX, USER_ENTRY_PREFIX);

            return [
              ...inject(),
              ...(options.exports
                ? [`export { ${options.exports.join(", ")} } from "${userEntryId}";`]
                : [
                    `import * as userEntry from "${userEntryId}";`,
                    `export * from "${userEntryId}";`,
                    `export default userEntry.default ?? {};`,
                  ]),
              "if (import.meta.hot) {",
              `  const { getExportTypes } = await import("${EXPORT_TYPES_ID}");`,
              "  import.meta.hot.accept((module) => {",
              "    const exportTypes = getExportTypes(module);",
              '    import.meta.hot.send("distilled-cloudflare:worker-export-types", exportTypes);',
              "  });",
              "}",
            ].join("\n");
          }
          if (id === EXPORT_TYPES_ID) {
            return `
import {
  WorkerEntrypoint,
  DurableObject,
  WorkflowEntrypoint,
} from "cloudflare:workers";

const baseClasses = new Map([
  ["WorkerEntrypoint", WorkerEntrypoint],
  ["DurableObject", DurableObject],
  ["WorkflowEntrypoint", WorkflowEntrypoint],
]);

export function getExportTypes(module) {
  const exportTypes = {};

  for (const [key, value] of Object.entries(module)) {
    if (key === "default") {
      continue;
    }

    let exportType;

    if (typeof value === "function") {
      for (const [type, baseClass] of baseClasses) {
        if (baseClass.prototype.isPrototypeOf(value.prototype)) {
          exportType = type;
          break;
        }
      }

      if (!exportType) {
        exportType = "DurableObject";
      }
    } else if (typeof value === "object" && value !== null) {
      exportType = "WorkerEntrypoint";
    }

    exportTypes[key] = exportType;
  }

  return exportTypes;
}`;
          }
          if (id.startsWith(INJECT_PREFIX)) {
            const injectedName = id.slice(INJECT_PREFIX.length);
            const moduleSpecifier = unenvApi?.inject[injectedName];
            if (!moduleSpecifier) {
              throw new Error(`Expected module specifier for "${injectedName}" to be defined`);
            }
            return [
              `import ${injectedName} from "${moduleSpecifier}";`,
              `globalThis.${injectedName} = ${injectedName};`,
            ].join("\n");
          }
        },
      },
    },
  };
});
