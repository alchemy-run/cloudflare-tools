declare module "*.wasm?init" {
  const init: () => Promise<unknown>;
  export default init;
}
