import addWasm from "../add.wasm";
import textContent from "../test.txt";
import binData from "../test.bin";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/wasm") {
      const instance = await WebAssembly.instantiate(addWasm);
      const add = instance.exports.add as (a: number, b: number) => number;
      return new Response(String(add(1, 2)));
    }

    if (url.pathname === "/text") {
      return new Response(textContent);
    }

    if (url.pathname === "/bin") {
      const bytes = new Uint8Array(binData);
      return new Response(JSON.stringify(Array.from(bytes)));
    }

    return new Response("ok");
  },
};
