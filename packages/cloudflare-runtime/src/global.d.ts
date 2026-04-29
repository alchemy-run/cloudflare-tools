declare module "workerd" {
  const bin:
    | string // it should be the binary path
    | {
        // but their exports are weird so sometimes it's this
        default: string;
        compatibilityDate: string;
        version: string;
      };
  export default bin;
  export const compatibilityDate: string;
  export const version: string;
}

declare module "worker:*" {
  // oxlint-disable-next-line typescript/consistent-type-imports
  export const modules: Array<import("./WorkerModule.ts").WorkerModule>;
}
