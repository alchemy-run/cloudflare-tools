export type WorkerRegistry = Record<string, WorkerDefinition>;

export type WorkerDefinition = {
  /**
   * Address of the workerd debug port for this worker's process (e.g. "127.0.0.1:12345").
   * The debug port provides native Cap'n Proto RPC access to all services/entrypoints.
   */
  debugPortAddress: string;
  /**
   * The workerd service name for the default entrypoint. This varies by worker type:
   * - Workers with assets: routes through the assets RPC proxy
   * - Vite workers: routes through the vite proxy worker
   * - Plain workers: routes directly to the user worker service
   */
  defaultEntrypointService: string;
  /**
   * The workerd service name for the user worker directly
   * For plain workers this is identical to defaultEntrypointService, but for other
   * workers it bypasses the Assets proxy (whether built-in or userland)
   */
  userWorkerService: string;
  /**
   * Map of workflow binding name to the workerd service name that hosts the
   * workflow's Engine + `WorkflowBinding` entrypoint in this worker's
   * process. Other instances can use this to route their workflow bindings
   * through the dev-registry proxy, ensuring only one process hosts the
   * Engine for a given workflow.
   *
   * The key matches `WorkflowEntry.name` (the workflow identifier shared
   * across instances), and the value is opaque to consumers — they just
   * forward it back into the debug port.
   */
  workflowServices?: Record<string, string>;
  /**
   * Map of queue name to the workerd service name that hosts the queue's
   * broker object-entry in this worker's process. Producers in other
   * instances route their `send()`/`sendBatch()` calls through the
   * dev-registry proxy to this service via the debug port, so a single
   * process owns the broker (and consumer) for a given queue.
   *
   * The key is the logical queue name (shared across instances); the value
   * is opaque to consumers — they forward it back into the debug port.
   */
  queueServices?: Record<string, string>;
};
