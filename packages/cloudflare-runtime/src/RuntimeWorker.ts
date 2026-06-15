import type { HyperdriveOrigin } from "./bindings/hyperdrive/HyperdriveOrigin.shared.ts";
import type { QueueConsumer } from "./bindings/queue/QueueOptions.shared.ts";
import type { ContainerImage } from "./Docker.ts";
import type { BindingHook } from "./PluginContext.ts";

export interface RuntimeWorker<B extends BindingHooks = BindingHooks> {
  readonly name: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly bindings: B;
  readonly modules: ReadonlyArray<Module>;
  readonly assets?: Assets;
  readonly hyperdrives?: Record<string, HyperdriveOrigin>;
  readonly durableObjectNamespaces?: ReadonlyArray<DurableObjectNamespace>;
  /**
   * Queues this worker consumes via its `queue()` handler. Each consumed
   * queue gets an in-memory broker hosted in this worker's process; producers
   * (local or in other dev instances) deliver to it.
   */
  readonly queueConsumers?: ReadonlyArray<QueueConsumer>;
}

export type BindingHooks = ReadonlyArray<BindingHook<any>>;

export type { HyperdriveOrigin } from "./bindings/hyperdrive/HyperdriveOrigin.shared.ts";
export type { QueueConsumer } from "./bindings/queue/QueueOptions.shared.ts";

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
  /**
   * If present, Durable Objects in this namespace have an attached container.
   * During local development the image is built (from a `dockerfile`) or
   * pulled (from an `imageUri`), tagged, and handed to workerd, which starts
   * one container per Durable Object instance and exposes it via `ctx.container`.
   *
   * Local dev only; requires Docker. Not supported on Windows (use WSL).
   */
  container?: ContainerImage;
}
