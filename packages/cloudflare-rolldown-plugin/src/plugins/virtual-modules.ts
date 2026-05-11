import type { Plugin } from "rolldown";
import { createPlugin } from "../factory.js";
import type { UnenvApi } from "./nodejs-compat.js";

// oxlint-disable-next-line no-control-regex
const VIRTUAL_MODULE_REGEXP = /^\0distilled:.*$/;

export const WORKER_ENTRY_PREFIX = "\0distilled:worker-entry:" as const;
const USER_ENTRY_PREFIX = "\0distilled:user-entry:" as const;
const PEAR_ENTRY_PREFIX = "\0distilled:pear-entry:" as const;
const INJECT_PREFIX = "\0distilled:inject:" as const;
const EXPORT_TYPES_ID = "\0distilled:export-types" as const;

export const virtualModulesPlugin = createPlugin("virtual-modules", (options) => {
  let unenvApi: UnenvApi | undefined;
  const inject = () => {
    if (!unenvApi) return "";
    return [
      ...unenvApi.polyfill.map((module) => `import "${module}";`),
      ...Object.keys(unenvApi.inject).map(
        (injectedName) => `import "${INJECT_PREFIX}${injectedName}";`,
      ),
    ].join("\n");
  };
  return {
    vite: {
      enforce: "pre",
    },
    shared: {
      buildStart({ plugins }) {
        unenvApi = plugins.find(
          (plugin): plugin is Plugin<UnenvApi> =>
            "name" in plugin && plugin.name === "distilled-cloudflare:nodejs-unenv",
        )?.api;
      },
      resolveId: {
        filter: { id: VIRTUAL_MODULE_REGEXP },
        handler(id) {
          // eslint-disable-next-line no-console
          console.log("resolveId", id, {
            startsWithWorker: id.startsWith(WORKER_ENTRY_PREFIX),
            startsWithPear: id.startsWith(PEAR_ENTRY_PREFIX),
            startsWithInject: id.startsWith(INJECT_PREFIX),
            startsWithUser: id.startsWith(USER_ENTRY_PREFIX),
            isExportTypes: id === EXPORT_TYPES_ID,
          });
          if (
            id.startsWith(WORKER_ENTRY_PREFIX) ||
            id.startsWith(PEAR_ENTRY_PREFIX) ||
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
        async handler(id) {
          if (id.startsWith(WORKER_ENTRY_PREFIX)) {
            const userEntry = id.replace(
              WORKER_ENTRY_PREFIX,
              options.compatibilityFlags?.includes("pear") ? PEAR_ENTRY_PREFIX : USER_ENTRY_PREFIX,
            );
            // eslint-disable-next-line no-console
            console.log("the worker entry is importing", userEntry);
            return `
${inject()}
import { getExportTypes } from "${EXPORT_TYPES_ID}";
import * as userEntry from "${userEntry}";
export default userEntry.default ?? {};
if (import.meta.hot) {
  import.meta.hot.accept((module) => {
    const exportTypes = getExportTypes(module);
    import.meta.hot.send("distilled-cloudflare:worker-export-types", exportTypes);
  });
}
`;
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
          if (id.startsWith(PEAR_ENTRY_PREFIX)) {
            // eslint-disable-next-line no-console
            console.log("PEAR from 228???");
            const resolvedId = id.replace(PEAR_ENTRY_PREFIX, USER_ENTRY_PREFIX);
            // eslint-disable-next-line no-console
            console.log("the pear entry is importing", resolvedId);
            return `
import userEntry from "${resolvedId}";
export default userEntry;
`;
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
