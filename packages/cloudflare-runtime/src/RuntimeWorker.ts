import type { HyperdriveOrigin } from "./bindings/hyperdrive/HyperdriveOrigin.shared.ts";
import type { BindingHook } from "./PluginContext.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";

export interface RuntimeWorker<B extends BindingHooks = BindingHooks> {
  readonly name: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly bindings: B;
  readonly modules: ReadonlyArray<Module>;
  readonly assets?: Assets;
  readonly hyperdrives?: Record<string, HyperdriveOrigin>;
  readonly durableObjectNamespaces?: ReadonlyArray<DurableObjectNamespace>;
}

export type BindingHooks = ReadonlyArray<BindingHook<any>>;

export type { HyperdriveOrigin } from "./bindings/hyperdrive/HyperdriveOrigin.shared.ts";

export type Module =
  | {
      name: string;
      type: "ESModule" | "CommonJsModule" | "Text" | "Json" | "PythonModule" | "PythonRequirement";
      content: string;
    }
  | {
      name: string;
      type: "Data" | "Wasm";
      content: Uint8Array;
    };

export interface Assets {
  directory?: string;
  headers?: string;
  redirects?: string;
  htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  notFoundHandling?: "none" | "404-page" | "single-page-application";
  runWorkerFirst?: Array<string> | boolean;
  serveDirectly?: boolean;
}

export interface DurableObjectNamespace {
  className: string;
  sql: boolean;
  uniqueKey?: string;
  ephemeralLocal?: true;
}

export const moduleToWorkerd = (module: Module): WorkerdConfig.Worker_Module => {
  switch (module.type) {
    case "ESModule":
      return { name: module.name, esModule: module.content };
    case "CommonJsModule":
      return { name: module.name, commonJsModule: module.content };
    case "Text":
      return { name: module.name, text: module.content };
    case "Data":
      return { name: module.name, data: module.content };
    case "Wasm":
      return { name: module.name, wasm: module.content };
    case "Json":
      return { name: module.name, json: module.content };
    case "PythonModule":
      return { name: module.name, pythonModule: module.content };
    case "PythonRequirement":
      return { name: module.name, pythonRequirement: module.content };
  }
};
