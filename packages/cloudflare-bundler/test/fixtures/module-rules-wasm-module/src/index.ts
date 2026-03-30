import addWasm from "../../module-rules/add.wasm?module";

export default {
  async fetch() {
    const instance = await WebAssembly.instantiate(addWasm);
    const add = instance.exports.add as (a: number, b: number) => number;
    return new Response(String(add(3, 4)));
  },
};
