import { createPlugin } from "../factory.js";
import { resolvePluginApi } from "../utils.js";
import type { UnenvApi } from "./nodejs-compat.js";

// oxlint-disable-next-line no-control-regex
const VIRTUAL_MODULE_REGEXP = /^\0distilled:.*$/;

export const WORKER_ENTRY_PREFIX = "\0distilled:worker-entry:" as const;
const USER_ENTRY_PREFIX = "\0distilled:user-entry:" as const;
const INJECT_PREFIX = "\0distilled:inject:" as const;
const EXPORT_TYPES_ID = "\0distilled:export-types" as const;

const missingDefaultExportMessage = (userEntryName: string): string =>
  `The worker entry module "${userEntryName}" has no default export. ` +
  `A Cloudflare Worker must default-export its handlers (e.g. \`export default { fetch }\`) ` +
  `or export a WorkerEntrypoint, DurableObject, or WorkflowEntrypoint class. ` +
  `If the entry is a framework server build without a default export ` +
  `(e.g. React Router's "virtual:react-router/server-build"), set the plugin's ` +
  `"main" option to a module that wraps the framework's request handler.`;

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
            const userEntryName = id.slice(WORKER_ENTRY_PREFIX.length);

            return [
              ...inject(),
              ...(options.exports
                ? [`export { ${options.exports.join(", ")} } from "${userEntryId}";`]
                : [
                    `import * as userEntry from "${userEntryId}";`,
                    `export * from "${userEntryId}";`,
                    // A worker entry without a default export is almost always
                    // a misconfiguration — e.g. React Router's
                    // `virtual:react-router/server-build` is a build manifest,
                    // not a worker. Silently deploying `export default {}`
                    // surfaces as Cloudflare's opaque "The uploaded script has
                    // no registered event handlers"; throw an actionable error
                    // instead. A default-less entry stays valid when it exports
                    // entrypoint classes (Durable Objects, Workflows,
                    // WorkerEntrypoints).
                    `import {`,
                    `  WorkerEntrypoint as __distilled_WorkerEntrypoint,`,
                    `  DurableObject as __distilled_DurableObject,`,
                    `  WorkflowEntrypoint as __distilled_WorkflowEntrypoint,`,
                    `} from "cloudflare:workers";`,
                    `if (userEntry.default === undefined) {`,
                    `  const hasEntrypointExport = Object.entries(userEntry).some(`,
                    `    ([key, value]) =>`,
                    `      key !== "default" &&`,
                    `      typeof value === "function" &&`,
                    `      value.prototype != null &&`,
                    `      (__distilled_WorkerEntrypoint.prototype.isPrototypeOf(value.prototype) ||`,
                    `        __distilled_DurableObject.prototype.isPrototypeOf(value.prototype) ||`,
                    `        __distilled_WorkflowEntrypoint.prototype.isPrototypeOf(value.prototype)),`,
                    `  );`,
                    `  if (!hasEntrypointExport) {`,
                    `    throw new Error(${JSON.stringify(missingDefaultExportMessage(userEntryName))});`,
                    `  }`,
                    `}`,
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
