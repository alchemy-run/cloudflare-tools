import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { HttpBody } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as DevRegistryProxyWorker from "worker:./workers/dev-registry-proxy.worker.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import { PluginContext } from "../PluginContext.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import type * as Workerd from "../workerd/Workerd.ts";
import {
  DEV_REGISTRY_DEBUG_PORT_BINDING,
  getOutboundDoProxyClassName,
  SERVICE_DEV_REGISTRY_PROXY,
  SOCKET_DEBUG_PORT,
  SOCKET_DEV_REGISTRY,
  USER_WORKER_SERVICE_NAME,
} from "./Constants.shared.ts";
import type { ExternalServiceMap } from "./DevRegistry.ts";
import { DevRegistry } from "./DevRegistry.ts";

/**
 * Per-worker plugin that accumulates external service / Durable Object
 * references discovered during binding resolution, then emits a
 * `dev-registry-proxy` worker service plus a dedicated push socket via
 * `defer`.
 */
export class DevRegistryProxy extends Plugin.Service<
  DevRegistryProxy,
  {
    /**
     * Record an external service binding referencing `scriptName` so the
     * proxy worker is configured to handle it.
     */
    readonly registerService: (
      scriptName: string,
      entrypoint: string | undefined,
      props: Record<string, unknown> | undefined,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
    /**
     * Record an external Durable Object referencing `scriptName`/`className`
     * so the proxy worker exports a matching proxy class.
     */
    readonly registerDurableObject: (
      scriptName: string,
      className: string,
      uniqueKey: string | undefined,
    ) => Effect.Effect<WorkerdConfig.Worker_DurableObjectNamespace>;
    /**
     * Record that this worker owns the given workflow and hosts its
     * `WorkflowBinding` entrypoint at `serviceName`. Used to populate the
     * `workflowServices` field on this worker's dev-registry entry so that
     * other instances can route their bindings here.
     */
    readonly registerOwnedWorkflow: (
      workflowName: string,
      serviceName: string,
    ) => Effect.Effect<void>;
    /**
     * Record an external workflow binding referencing `scriptName`/
     * `workflowName` so the proxy worker is configured to forward
     * `WorkflowBinding` RPCs to the owning instance via the debug port.
     */
    readonly registerExternalWorkflow: (
      scriptName: string,
      workflowName: string,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
    /**
     * Record that this worker consumes (and hosts the broker for) the given
     * queue at `serviceName`. Populates the `queueServices` field on this
     * worker's dev-registry entry so producers in other instances can route
     * their queue bindings here.
     */
    readonly registerOwnedQueue: (queueName: string, serviceName: string) => Effect.Effect<void>;
    /**
     * Record a producer binding for a queue consumed by another instance, so
     * the proxy worker forwards `send()`/`sendBatch()` calls to the owning
     * instance's broker via the debug port. Returns the `ExternalQueueProxy`
     * designator to use as the `queue` binding target.
     */
    readonly registerExternalQueue: (
      queueName: string,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/DevRegistryProxy") {}

export const DevRegistryProxyLive = Layer.effect(
  DevRegistryProxy,
  Effect.gen(function* () {
    const devRegistry = yield* DevRegistry;
    const http = yield* HttpClient.HttpClient;
    return DevRegistryProxy.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext;
        // Per-worker accumulator. The plugin builder runs once per
        // `Runtime.start`, so each worker gets its own externals map.
        const externals: ExternalServiceMap = new Map();
        const externalDOs: Array<{ scriptName: string; className: string; uniqueKey: string }> = [];
        // Workflows we own and that other instances are allowed to route to
        // via this worker's dev-registry entry.
        const ownedWorkflows = new Map<string, string>();
        // Workflows we consume that live in another instance. Tracked
        // separately from `externals` because resolution goes through a
        // dedicated proxy entrypoint that resolves by workflow name, not
        // service entrypoint.
        const externalWorkflows = new Set<string>();
        // Queues this worker consumes (and hosts the broker for), published in
        // this worker's dev-registry entry as `queueServices`.
        const ownedQueues = new Map<string, string>();
        // Queues consumed by another instance that this worker produces to.
        // The proxy worker resolves the consumer dynamically by queue name.
        const externalQueues = new Set<string>();
        const start = Effect.fn(function* (
          ports: Workerd.WorkerdPorts,
        ): Effect.fn.Return<void, never, Scope.Scope> {
          const debugPort = ports[SOCKET_DEBUG_PORT];
          if (debugPort === undefined) {
            return;
          }
          yield* devRegistry.register({
            [worker.name]: {
              debugPortAddress: `127.0.0.1:${debugPort}`,
              // Until we add asset-proxy / vite-override branches, the user
              // worker IS the default entrypoint.
              defaultEntrypointService: USER_WORKER_SERVICE_NAME,
              userWorkerService: USER_WORKER_SERVICE_NAME,
              workflowServices:
                ownedWorkflows.size > 0 ? Object.fromEntries(ownedWorkflows) : undefined,
              queueServices: ownedQueues.size > 0 ? Object.fromEntries(ownedQueues) : undefined,
            },
          });
          if (externals.size === 0 && externalQueues.size === 0) {
            return;
          }
          const devRegistryPort = ports[SOCKET_DEV_REGISTRY];
          if (devRegistryPort === undefined) {
            return;
          }
          const pushUrl = `http://127.0.0.1:${devRegistryPort}/`;
          yield* devRegistry.subscribe(externals, externalQueues, (registry) => {
            void Effect.runPromise(http.post(pushUrl, { body: HttpBody.jsonUnsafe(registry) }));
          });
        });
        const getOrCreate = (scriptName: string) => {
          let entry = externals.get(scriptName);
          if (!entry) {
            entry = { classNames: new Set(), entrypoints: new Set() };
            externals.set(scriptName, entry);
          }
          return entry;
        };
        const defer = Effect.gen(function* () {
          if (externals.size === 0 && externalWorkflows.size === 0 && externalQueues.size === 0) {
            return {};
          }
          const initialRegistry = yield* devRegistry.getRegistry();
          const proxyService: WorkerdConfig.Service = {
            name: SERVICE_DEV_REGISTRY_PROXY,
            worker: {
              compatibilityDate: "2025-01-01",
              compatibilityFlags: ["service_binding_extra_handlers"],
              modules: buildWorkerModules(externals, initialRegistry),
              bindings: [
                {
                  name: DEV_REGISTRY_DEBUG_PORT_BINDING,
                  workerdDebugPort: WorkerdConfig.kVoid,
                },
              ],
              durableObjectStorage: { inMemory: WorkerdConfig.kVoid },
              durableObjectNamespaces: externalDOs.map(({ scriptName, className, uniqueKey }) => ({
                className: getOutboundDoProxyClassName(scriptName, className),
                // Must match the unique key that the target session uses for
                // this DO so workerd produces identical IDs across sessions.
                uniqueKey,
              })),
            },
          };
          // Dedicated socket for #pushRegistryUpdate so registry pushes don't
          // route through the entry worker (which can break on Windows with
          // WSARecv error 64 in service-to-service forwarding).
          const pushSocket: WorkerdConfig.Socket = {
            name: SOCKET_DEV_REGISTRY,
            address: "127.0.0.1:0",
            service: { name: SERVICE_DEV_REGISTRY_PROXY },
            http: {},
          };
          return {
            services: [proxyService],
            sockets: [pushSocket],
          };
        });
        return {
          defer,
          start,
          api: {
            registerService: (scriptName, entrypoint, props) =>
              Effect.sync(() => {
                getOrCreate(scriptName).entrypoints.add(entrypoint);
                return {
                  name: SERVICE_DEV_REGISTRY_PROXY,
                  entrypoint: "ExternalServiceProxy",
                  props: {
                    json: JSON.stringify({
                      service: scriptName,
                      entrypoint: entrypoint ?? null,
                      userProps: props,
                    }),
                  },
                };
              }),
            registerDurableObject: (scriptName, className, uniqueKey) =>
              Effect.sync(() => {
                getOrCreate(scriptName).classNames.add(className);
                externalDOs.push({
                  scriptName,
                  className,
                  uniqueKey: uniqueKey ?? `${scriptName}-${className}`,
                });
                return {
                  className: getOutboundDoProxyClassName(scriptName, className),
                  serviceName: SERVICE_DEV_REGISTRY_PROXY,
                };
              }),
            registerOwnedWorkflow: (workflowName, serviceName) =>
              Effect.sync(() => {
                ownedWorkflows.set(workflowName, serviceName);
              }),
            registerExternalWorkflow: (scriptName, workflowName) =>
              Effect.sync(() => {
                // Ensure the proxy worker is built. `entrypoints` is unused
                // for workflows (we resolve by workflow name in the proxy),
                // but the proxy worker is only created when externals are
                // non-empty, so we mark this script as having dependents.
                getOrCreate(scriptName);
                externalWorkflows.add(scriptName);
                return {
                  name: SERVICE_DEV_REGISTRY_PROXY,
                  entrypoint: "ExternalWorkflowProxy",
                  props: {
                    json: JSON.stringify({ scriptName, workflowName }),
                  },
                };
              }),
            registerOwnedQueue: (queueName, serviceName) =>
              Effect.sync(() => {
                ownedQueues.set(queueName, serviceName);
              }),
            registerExternalQueue: (queueName) =>
              Effect.sync(() => {
                externalQueues.add(queueName);
                return {
                  name: SERVICE_DEV_REGISTRY_PROXY,
                  entrypoint: "ExternalQueueProxy",
                  props: {
                    json: JSON.stringify({ queueName }),
                  },
                };
              }),
          },
        };
      }),
    );
  }),
);

const buildWorkerModules = (
  externals: ExternalServiceMap,
  initialRegistry: Record<string, unknown>,
) => {
  const proxyWorkerEntryName = Object.keys(DevRegistryProxyWorker.modules)[0];
  const externalDOs: Array<[string, string]> = [];
  for (const [scriptName, { classNames }] of externals) {
    for (const className of classNames) {
      externalDOs.push([scriptName, className]);
    }
  }
  const main = [
    `import { ExternalServiceProxy, ExternalWorkflowProxy, ExternalQueueProxy, setRegistry, createProxyDurableObjectClass } from "./${proxyWorkerEntryName}";`,
    `export { ExternalServiceProxy, ExternalWorkflowProxy, ExternalQueueProxy };`,
    `setRegistry(${JSON.stringify(initialRegistry)});`,
    `export default {`,
    `  async fetch(request) {`,
    `    if (request.method === "POST") {`,
    `      const data = await request.json();`,
    `      setRegistry(data);`,
    `      return new Response("ok");`,
    `    }`,
    `    return new Response("not found", { status: 404 });`,
    `  }`,
    `};`,
    ...externalDOs.map(
      ([scriptName, className]) =>
        `export const ${getOutboundDoProxyClassName(
          scriptName,
          className,
        )} = createProxyDurableObjectClass({ scriptName: ${JSON.stringify(
          scriptName,
        )}, className: ${JSON.stringify(className)} });`,
    ),
    "",
  ].join("\n");
  return formatInternalWorkerModules({
    modules: {
      "index.worker.mjs": main,
      ...DevRegistryProxyWorker.modules,
    },
  });
};
