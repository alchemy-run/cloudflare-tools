import wasmModule from "./add.wasm?init";

export default {
  async fetch() {
    const instance = await wasmModule();
    const add = instance.exports.add as (a: number, b: number) => number;
    return new Response(String(add(1, 2)));
  },
};
