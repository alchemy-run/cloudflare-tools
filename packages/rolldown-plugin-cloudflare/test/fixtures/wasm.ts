import wasmModule from "./add.wasm";

export default {
  async fetch() {
    const instance = await WebAssembly.instantiate(wasmModule);
    const add = instance.exports.add as (a: number, b: number) => number;
    return new Response(String(add(1, 2)));
  },
};
