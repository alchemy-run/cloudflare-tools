import type { Plugin } from "rolldown";
import { esmExternalRequirePlugin } from "rolldown/plugins";
import { createUnplugin } from "unplugin";
import { resolveUnenv } from "../nodejs-compat-env.js";

const WORKER_ENTRY_ID = "virtual:distilled-cloudflare/worker-entry";
const USER_ENTRY_ID = "virtual:distilled-cloudflare/user-entry";
const GLOBAL_INJECT_PREFIX = "virtual:distilled-cloudflare/nodejs-global-inject/";

interface InjectBinding {
  readonly exportName: string;
  readonly moduleId: string;
  readonly injectedName: string;
}

interface ResolvedNodejsCompatOptions {
  readonly entry: string;
  readonly polyfill: ReadonlyArray<string>;
  readonly nodeModulePattern: RegExp;
  readonly injectModules: ReadonlyMap<string, ReadonlyArray<InjectBinding>>;
  readonly resolveImport: (source: string) =>
    | {
        readonly id: string;
        readonly external: boolean;
      }
    | undefined;
}

const nodejsCompat = createUnplugin<ResolvedNodejsCompatOptions>((options) => ({
  name: "distilled-nodejs-compat",
  resolveId(id) {
    if (id === WORKER_ENTRY_ID || id === USER_ENTRY_ID || id.startsWith(GLOBAL_INJECT_PREFIX)) {
      return id;
    }

    const resolvedImport = options.resolveImport(id);
    if (resolvedImport) {
      return {
        id: resolvedImport.id,
        external: resolvedImport.external,
      };
    }

    if (options.nodeModulePattern.test(id)) {
      return {
        id,
        external: true,
      };
    }

    return null;
  },
  load(id) {
    if (id === USER_ENTRY_ID) {
      return [
        `export * from ${JSON.stringify(options.entry)};`,
        `export { default } from ${JSON.stringify(options.entry)};`,
      ].join("\n");
    }

    if (id === WORKER_ENTRY_ID) {
      const lines = [
        ...Array.from(
          options.injectModules.keys(),
          (moduleId) => `import ${JSON.stringify(moduleId)};`,
        ),
        ...options.polyfill.map((moduleId) => `import ${JSON.stringify(moduleId)};`),
        `import * as userWorker from ${JSON.stringify(USER_ENTRY_ID)};`,
        `export * from ${JSON.stringify(USER_ENTRY_ID)};`,
        `export default userWorker.default ?? {};`,
      ];
      return lines.join("\n");
    }

    if (!id.startsWith(GLOBAL_INJECT_PREFIX)) {
      return null;
    }

    const injects = options.injectModules.get(id);
    if (!injects) {
      return null;
    }

    const grouped = new Map<string, Array<InjectBinding>>();
    for (const inject of injects) {
      const items = grouped.get(inject.moduleId) ?? [];
      items.push(inject);
      grouped.set(inject.moduleId, items);
    }

    const lines: Array<string> = [];
    for (const [moduleId, bindings] of grouped) {
      const specifiers = bindings.map((binding) =>
        binding.exportName === "default"
          ? `default as ${binding.injectedName}Value`
          : `${binding.exportName} as ${binding.injectedName}Value`,
      );
      lines.push(`import { ${specifiers.join(", ")} } from ${JSON.stringify(moduleId)};`);
      for (const binding of bindings) {
        lines.push(`globalThis.${binding.injectedName} = ${binding.injectedName}Value;`);
      }
    }
    return lines.join("\n");
  },
}));

const createInjectModules = (inject: Record<string, string | ReadonlyArray<string>>) => {
  const modules = new Map<string, Array<InjectBinding>>();

  for (const [injectedName, value] of Object.entries(inject)) {
    const moduleId = typeof value === "string" ? value : (value[0] as string);
    const exportName = typeof value === "string" ? "default" : (value[1] as string);
    const virtualId = `${GLOBAL_INJECT_PREFIX}${moduleId}`;
    const items = modules.get(virtualId) ?? [];
    items.push({
      injectedName,
      exportName,
      moduleId,
    });
    modules.set(virtualId, items);
  }

  return modules;
};

export interface NodejsCompatPluginOptions {
  readonly entry: string;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: ReadonlyArray<string>;
}

export async function createNodejsCompatPlugin(options: NodejsCompatPluginOptions): Promise<{
  readonly plugins: ReadonlyArray<Plugin>;
  readonly entryId: string;
}> {
  const env = await resolveUnenv({
    ...(options.compatibilityDate ? { compatibilityDate: options.compatibilityDate } : {}),
    ...(options.compatibilityFlags ? { compatibilityFlags: options.compatibilityFlags } : {}),
  });

  return {
    plugins: [
      esmExternalRequirePlugin({
        external: [...env.external],
        skipDuplicateCheck: true,
      }) as Plugin,
      nodejsCompat.rolldown({
        entry: options.entry,
        polyfill: env.polyfill,
        nodeModulePattern: env.nodeModulePattern,
        injectModules: createInjectModules(env.inject),
        resolveImport: env.resolveImport,
      }) as Plugin,
    ],
    entryId: WORKER_ENTRY_ID,
  };
}
