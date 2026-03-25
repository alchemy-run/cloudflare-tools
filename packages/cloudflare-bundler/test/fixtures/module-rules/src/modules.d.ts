declare module "*.wasm" {
  const value: ArrayBuffer;
  export default value;
}

declare module "*.txt" {
  const value: string;
  export default value;
}

declare module "*.bin" {
  const value: ArrayBuffer;
  export default value;
}
