import type * as workers from "@distilled.cloud/cloudflare/workers";
import type { WorkerModule } from "./WorkerModule";

export interface Worker {
  name: string;
  compatibilityDate: string;
  compatibilityFlags: Array<string>;
  bindings: Array<Binding>;
  /**
   * Local-mode connection details for hyperdrive bindings, keyed by
   * binding name. When set, the runtime wires the matching hyperdrive
   * binding to the given database via a workerd `external` TCP service
   */
  hyperdrives?: Record<string, HyperdriveOrigin>;
  durableObjectNamespaces?: Array<DurableObjectNamespace>;
  modules: Array<WorkerModule>;
  assets?: Assets;
}

export interface DurableObjectNamespace {
  className: string;
  sql: boolean;
  uniqueKey: string;
}

/**
 * Connection details for a hyperdrive binding running in local mode.
 */
export interface HyperdriveOrigin {
  scheme: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode?: string;
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
