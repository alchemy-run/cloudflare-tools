import { createPlugin } from "../factory.js";
import { sanitizePath } from "../utils.js";

const WASM_INIT_QUERY = /\.wasm\?init$/;

export const wasmInitPlugin = createPlugin("wasm-init", () => ({
  shared: {
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
  },
}));
