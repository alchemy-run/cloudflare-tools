import type { Plugin } from "rolldown";

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
    plugin: {
      name: "distilled-nodejs-compat-warnings",
      resolveId: {
        filter: { id: pattern },
        handler(id) {
          imports.add(id);
          return {
            id,
            external: true,
          };
        },
      },
    },
    getWarnings: () =>
      imports.size === 0
        ? []
        : [
            `Node.js built-ins were imported without \`nodejs_compat\`: ${Array.from(imports).sort().join(", ")}`,
          ],
  };
}
