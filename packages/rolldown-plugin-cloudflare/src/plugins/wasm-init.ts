import { sanitizePath } from "#/sanitize-path";
import type { Plugin } from "rolldown";

const WASM_INIT_QUERY = /\.wasm\?init$/;

export const wasmInitPlugin: Plugin = {
  name: "rolldown-plugin-cloudflare:wasm-init",
  load: {
    filter: { id: WASM_INIT_QUERY },
    handler(id) {
      return [
        `import wasmModule from "${sanitizePath(id)}";`,
        `export default async (imports) => {`,
        `  const result = await WebAssembly.instantiate(wasmModule, imports);`,
        `  return "instance" in result ? result.instance : result;`,
        `};`,
      ].join("\n");
    },
  },
};
