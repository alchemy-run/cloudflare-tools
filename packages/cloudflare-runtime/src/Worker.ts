import type * as workers from "@distilled.cloud/cloudflare/workers";

export interface Worker {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: Array<string>;
  bindings: Array<Binding>;
  durableObjectNamespaces?: Array<DurableObjectNamespace>;
  modules: Array<Module>;
  assets?: Assets;
}

export interface DurableObjectNamespace {
  className: string;
  sql: boolean;
  uniqueKey: string;
}

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

type WorkerMetadata = workers.PutScriptRequest["metadata"];
export type Binding = NonNullable<WorkerMetadata["bindings"]>[number];

export interface Assets {
  headers?: string;
  redirects?: string;
  htmlHandling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  notFoundHandling?: "none" | "404-page" | "single-page-application";
  runWorkerFirst?: Array<string> | boolean;
  serveDirectly?: boolean;
}
