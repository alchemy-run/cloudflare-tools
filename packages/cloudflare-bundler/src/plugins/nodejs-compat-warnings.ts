import type { Plugin } from "rolldown";
import { createUnplugin } from "unplugin";

interface NodejsCompatWarningsOptions {
  readonly pattern: RegExp;
  readonly imports: Set<string>;
}

const nodejsCompatWarnings = createUnplugin<NodejsCompatWarningsOptions>((options) => ({
  name: "distilled-nodejs-compat-warnings",
  resolveId: {
    filter: {
      id: options.pattern,
    },
    handler(id) {
      options.imports.add(id);
      return {
        id,
        external: true,
      };
    },
  },
}));

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function createNodejsCompatWarningsPlugin(): Promise<{
  readonly plugin: Plugin;
  readonly getWarnings: () => ReadonlyArray<string>;
}> {
  const { nonPrefixedNodeModules } = await import("@cloudflare/unenv-preset");
  const pattern = new RegExp(
    `^(${nonPrefixedNodeModules.map((module) => escapePattern(module)).join("|")}|node:.+)$`,
  );
  const imports = new Set<string>();

  return {
    plugin: nodejsCompatWarnings.rolldown({ pattern, imports }) as Plugin,
    getWarnings: () =>
      imports.size === 0
        ? []
        : [
            `Node.js built-ins were imported without \`nodejs_compat\`: ${Array.from(imports).sort().join(", ")}`,
          ],
  };
}
