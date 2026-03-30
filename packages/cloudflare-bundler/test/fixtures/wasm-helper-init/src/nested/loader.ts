import initWasm from "../../../module-rules/add.wasm?init";

interface Instance {
  exports: {
    add(a: number, b: number): number;
  };
}

export default async () => (await initWasm()) as Instance;
