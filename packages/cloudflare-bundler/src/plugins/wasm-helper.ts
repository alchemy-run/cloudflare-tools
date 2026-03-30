import type { Plugin } from "rolldown";

const WASM_INIT_QUERY = /\.wasm\?init$/;
const WASM_INIT_PREFIX = "\0distilled-wasm-init:";

const resolveWasmId = (id: string, importer: string | undefined) => {
  const resolvedId = id.replace(/\?init$/, "");
  return importer && resolvedId.startsWith(".")
    ? new URL(resolvedId, `file://${importer}`).pathname
    : resolvedId;
};

export const wasmHelperPlugin = (): Plugin => ({
  name: "distilled-wasm-helper",
  resolveId(id, importer) {
    if (!WASM_INIT_QUERY.test(id)) {
      return null;
    }

    return `${WASM_INIT_PREFIX}${resolveWasmId(id, importer)}`;
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
      `  return "instance" in result ? result.instance : result;`,
      `};`,
    ].join("\n");
  },
});
