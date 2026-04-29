import type * as workers from "@distilled.cloud/cloudflare/workers";
import type { WorkerModule } from "./WorkerModule";

export interface Worker {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: Array<string>;
  bindings: Array<Binding>;
  durableObjectNamespaces?: Array<DurableObjectNamespace>;
  modules: Array<WorkerModule>;
  assets?: Assets;
}

export interface DurableObjectNamespace {
  className: string;
  sql: boolean;
  uniqueKey: string;
}

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
