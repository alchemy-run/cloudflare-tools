import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { HttpBody } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as DevRegistryProxyWorker from "worker:./workers/dev-registry-proxy.worker.ts";
import * as Plugin from "../Plugin.ts";
import { PluginContext } from "../PluginContext.ts";
import { moduleToWorkerd } from "../RuntimeWorker.ts";
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
    ) => Effect.Effect<WorkerdConfig.Worker_DurableObjectNamespace>;
  }
>()("cloudflare-runtime/plugin/DevRegistryProxy") {}

const PROXY_MAIN_MODULE_NAME = "__dev-registry-proxy-main.mjs";

const proxyWorkerEntryName = DevRegistryProxyWorker.modules[0].name;

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
            },
          });
          if (externals.size === 0) {
            return;
          }
          const devRegistryPort = ports[SOCKET_DEV_REGISTRY];
          if (devRegistryPort === undefined) {
            return;
          }
          const pushUrl = `http://127.0.0.1:${devRegistryPort}/`;
          yield* devRegistry.subscribe(externals, (registry) => {
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
          if (externals.size === 0) {
            return {};
          }
          const initialRegistry = yield* devRegistry.getRegistry();
          const mainModuleSource = buildMainModule(externals, initialRegistry);
          const externalDOs: Array<[string, string]> = [];
          for (const [scriptName, { classNames }] of externals) {
            for (const className of classNames) {
              externalDOs.push([scriptName, className]);
            }
          }
          const proxyService: WorkerdConfig.Service = {
            name: SERVICE_DEV_REGISTRY_PROXY,
            worker: {
              compatibilityDate: "2025-01-01",
              compatibilityFlags: ["service_binding_extra_handlers"],
              modules: [
                {
                  name: PROXY_MAIN_MODULE_NAME,
                  type: "ESModule" as const,
                  content: mainModuleSource,
                },
                ...DevRegistryProxyWorker.modules,
              ].map(moduleToWorkerd),
              bindings: [
                {
                  name: DEV_REGISTRY_DEBUG_PORT_BINDING,
                  workerdDebugPort: WorkerdConfig.kVoid,
                },
              ],
              durableObjectStorage: { inMemory: WorkerdConfig.kVoid },
              durableObjectNamespaces: externalDOs.map(([scriptName, className]) => ({
                className: getOutboundDoProxyClassName(scriptName, className),
                // Must match the unique key that the target session uses for
                // this DO so workerd produces identical IDs across sessions.
                uniqueKey: `${scriptName}-${className}`,
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
            registerDurableObject: (scriptName, className) =>
              Effect.sync(() => {
                getOrCreate(scriptName).classNames.add(className);
                return {
                  className: getOutboundDoProxyClassName(scriptName, className),
                  serviceName: SERVICE_DEV_REGISTRY_PROXY,
                };
              }),
          },
        };
      }),
    );
  }),
);

const buildMainModule = (
  externals: ExternalServiceMap,
  initialRegistry: Record<string, unknown>,
): string => {
  const externalDOs: Array<[string, string]> = [];
  for (const [scriptName, { classNames }] of externals) {
    for (const className of classNames) {
      externalDOs.push([scriptName, className]);
    }
  }
  return [
    `import { ExternalServiceProxy, setRegistry, createProxyDurableObjectClass } from "./${proxyWorkerEntryName}";`,
    `export { ExternalServiceProxy };`,
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
};
