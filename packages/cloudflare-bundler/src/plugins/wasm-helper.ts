import type { Plugin } from "rolldown";
import { createUnplugin } from "unplugin";

const WASM_INIT_QUERY = /\.wasm\?init$/;
const WASM_INIT_PREFIX = "\0distilled-wasm-init:";

const wasmHelper = createUnplugin(() => ({
  name: "distilled-wasm-helper",
  resolveId: {
    filter: {
      id: WASM_INIT_QUERY,
    },
    handler(id, importer) {
      const resolvedId = id.replace(/\?init$/, "");
      const absoluteId =
        importer && resolvedId.startsWith(".")
          ? new URL(resolvedId, `file://${importer}`).pathname
          : resolvedId;
      return `${WASM_INIT_PREFIX}${absoluteId}`;
    },
  },
  load(id) {
    if (!id.startsWith(WASM_INIT_PREFIX)) {
      return null;
    }

    const wasmId = id.slice(WASM_INIT_PREFIX.length).replace(/\?init$/, "");
    return [
      `import wasmModule from ${JSON.stringify(wasmId)};`,
      `export default async (imports) => {`,
      `  const result = await WebAssembly.instantiate(wasmModule, imports);`,
      `  return result.instance;`,
      `};`,
    ].join("\n");
  },
}));

export const wasmHelperPlugin = (): Plugin => wasmHelper.rolldown() as Plugin;
