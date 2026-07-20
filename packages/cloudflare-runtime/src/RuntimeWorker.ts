import type { HyperdriveOrigin } from "./bindings/hyperdrive/HyperdriveOrigin.shared.ts";
import type { QueueConsumer } from "./bindings/queue/QueueOptions.shared.ts";
import type { ContainerImage } from "./Docker.ts";
import type { BindingHook } from "./PluginContext.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";
import type { OutputSink } from "./workerd/Workerd.ts";

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
  /**
   * Controls how output from the underlying `workerd` process is surfaced.
   *
   * By default, workerd does not log uncaught exceptions thrown by the
   * worker — they surface as bare `500 Internal Server Error` responses with
   * no output anywhere. Set `verbose: true` to have workerd log them
   * (message + stack) to stderr, and optionally `onOutput` to capture the
   * process output instead of inheriting the parent process's stdio.
   */
  readonly logging?: WorkerdLogging;
  readonly unsafe?: Partial<WorkerdConfig.Worker>;
}

export interface WorkerdLogging {
  /**
   * Pass `--verbose` to workerd. Enables INFO-level logging, which includes
   * uncaught exceptions thrown by the worker (message + stack, written to
   * stderr) — without it, those exceptions surface as bare
   * `500 Internal Server Error` responses with no log output anywhere.
   */
  readonly verbose?: boolean;
  /**
   * Capture the workerd process's stdout/stderr output instead of piping it
   * to the parent process's stdio. Output produced before the process
   * finishes starting is not captured; startup failures surface as typed
   * errors instead.
   */
  readonly onOutput?: OutputSink;
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
   * Attach a container to every Durable Object in this namespace. workerd
   * starts one per DO instance via the worker's `containerEngine` and exposes
   * it as `ctx.container`.
   */
  container?: ContainerImage;
}
