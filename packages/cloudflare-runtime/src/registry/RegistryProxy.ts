import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeCrypto from "node:crypto";
import * as RegistryProxyWorker from "worker:./RegistryProxy.worker.ts";
import { SERVICE_USER_WORKER } from "../internal/constants.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import { PluginContext } from "../PluginContext.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as Registry from "./Registry.ts";
import type { ResolvedServiceMap, SubscriberEntry } from "./RegistryTypes.shared.ts";

export class RegistryProxy extends Plugin.Service<
  RegistryProxy,
  {
    readonly publish: (service: PublishedService) => Effect.Effect<void>;
    readonly subscribe: <T extends SubscriberEntry>(
      subscriber: T,
    ) => Effect.Effect<ServiceDesignatorFromSubscriber<T>>;
  }
>()("cloudflare-runtime/plugin/RegistryProxy") {}

type ServiceDesignatorFromSubscriber<T extends SubscriberEntry> = T extends {
  kind: "durable-object";
}
  ? WorkerdConfig.Worker_DurableObjectNamespace
  : WorkerdConfig.ServiceDesignator;

type PublishedService =
  | SubscriberEntry.DurableObject
  | (SubscriberEntry.QueueConsumer & { service: string })
  | (Omit<SubscriberEntry.Workflow, "scriptName"> & { service: string });

const SERVICE_REGISTRY_PROXY = "cloudflare-runtime:registry-proxy";
const SOCKET_REGISTRY_PROXY = "registry-proxy-socket";
const SOCKET_DEBUG_PORT = "debug-port";

export const RegistryProxyLive = Layer.effect(
  RegistryProxy,
  Effect.gen(function* () {
    const registry = yield* Registry.Registry;
    const http = yield* HttpClient.HttpClient;

    return RegistryProxy.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext;
        const published: Array<PublishedService> =
          worker.durableObjectNamespaces?.map((namespace) => ({
            kind: "durable-object",
            scriptName: worker.name,
            className: namespace.className,
            uniqueKey: namespace.uniqueKey ?? `${worker.name}-${namespace.className}`,
          })) ?? [];
        const subscribed: Array<SubscriberEntry> = [];

        const writeRegistry = Effect.fn(function* (ports: Record<string, number>) {
          const debugPort = ports[SOCKET_DEBUG_PORT];
          if (!debugPort) {
            return yield* new SystemError({
              subtag: "RegistryProxyDebugPort",
              message: "Registry proxy debug port not found",
              hint: "The registry proxy debug port is not found.",
              detail: { debugPort },
            });
          }
          yield* registry.write({
            scriptName: worker.name,
            debugPortAddress: `127.0.0.1:${debugPort}`,
            services: [
              {
                kind: "worker",
                fetchService: SERVICE_USER_WORKER,
                rpcService: SERVICE_USER_WORKER,
              },
              ...published.map((service) => ({
                ...service,
                service: "service" in service ? service.service : SERVICE_USER_WORKER,
              })),
            ],
          });
        });
        const subscribeRegistry = Effect.fn(function* (ports: Record<string, number>) {
          if (subscribed.length === 0) {
            return;
          }
          const registryPort = ports[SOCKET_REGISTRY_PROXY];
          if (!registryPort) {
            return yield* new SystemError({
              subtag: "RegistryProxyRegistryPort",
              message: "Registry proxy registry port not found",
              hint: "The registry proxy registry port is not found.",
              detail: { registryPort },
            });
          }
          yield* registry.subscribe(subscribed).pipe(
            Stream.runForEach((services) =>
              http.post(`http://127.0.0.1:${registryPort}/`, {
                body: HttpBody.jsonUnsafe(services),
              }),
            ),
            Effect.forkScoped,
          );
        });

        return {
          defer: Effect.gen(function* () {
            if (subscribed.length === 0) {
              return {};
            }
            const durableObjects = subscribed.filter(
              (subscriber) => subscriber.kind === "durable-object",
            );
            const service: WorkerdConfig.Service = {
              name: SERVICE_REGISTRY_PROXY,
              worker: {
                compatibilityDate: "2025-01-01",
                compatibilityFlags: ["service_binding_extra_handlers"],
                modules: buildWorkerModules(yield* registry.read(subscribed), durableObjects),
                bindings: [
                  {
                    name: "REGISTRY_DEBUG_PORT",
                    workerdDebugPort: WorkerdConfig.kVoid,
                  },
                ],
                durableObjectStorage: { inMemory: WorkerdConfig.kVoid },
                durableObjectNamespaces: durableObjects.map((subscriber) => ({
                  className: externalDurableObjectClassName(
                    subscriber.scriptName,
                    subscriber.className,
                  ),
                  uniqueKey: subscriber.uniqueKey,
                })),
              },
            };
            const socket: WorkerdConfig.Socket = {
              name: SOCKET_REGISTRY_PROXY,
              address: "127.0.0.1:0",
              service: { name: SERVICE_REGISTRY_PROXY },
            };
            return { sockets: [socket], services: [service] };
          }),
          start: Effect.fn(function* (ports) {
            yield* Effect.all([writeRegistry(ports), subscribeRegistry(ports)], {
              concurrency: "unbounded",
            });
          }),
          api: {
            publish: (entry) =>
              Effect.sync(() => {
                published.push(entry);
              }),
            subscribe: <T extends SubscriberEntry>(subscriber: T) =>
              Effect.sync<ServiceDesignatorFromSubscriber<T>>(() => {
                subscribed.push(subscriber);
                switch (subscriber.kind) {
                  case "worker":
                    return {
                      name: SERVICE_REGISTRY_PROXY,
                      entrypoint: "ExternalService",
                      props: {
                        json: JSON.stringify(subscriber),
                      },
                    };
                  case "durable-object":
                    return {
                      serviceName: SERVICE_REGISTRY_PROXY,
                      className: externalDurableObjectClassName(
                        subscriber.scriptName,
                        subscriber.className,
                      ),
                    };
                  case "queue-consumer":
                    return {
                      name: SERVICE_REGISTRY_PROXY,
                      entrypoint: "ExternalQueueConsumer",
                      props: {
                        json: JSON.stringify(subscriber),
                      },
                    };
                  case "workflow":
                    return {
                      name: SERVICE_REGISTRY_PROXY,
                      entrypoint: "ExternalWorkflow",
                      props: {
                        json: JSON.stringify(subscriber),
                      },
                    };
                }
              }),
          },
        };
      }),
    );
  }),
);

const externalDurableObjectClassName = (scriptName: string, className: string) =>
  `ExternalDurableObject_${NodeCrypto.createHash("sha256").update(scriptName).update(className).digest("hex").slice(0, 16)}`;

const buildWorkerModules = (
  initialRegistry: ResolvedServiceMap,
  durableObjects: ReadonlyArray<SubscriberEntry.DurableObject>,
) => {
  const entryName = Object.keys(RegistryProxyWorker.modules)[0];
  const main = [
    `import { makeExternalDurableObject, Services } from "./${entryName}";`,
    `export { ExternalService, ExternalWorkflow, ExternalQueueConsumer } from "./${entryName}";`,
    `Services.set(${JSON.stringify(initialRegistry)});`,
    `export default {`,
    `  async fetch(request) {`,
    `    if (request.method === "POST") {`,
    `      const data = await request.json();`,
    `      Services.set(data);`,
    `      return new Response("ok");`,
    `    }`,
    `    return new Response("not found", { status: 404 });`,
    `  }`,
    `};`,
    ...durableObjects.map(
      (subscriber) =>
        `export const ${externalDurableObjectClassName(subscriber.scriptName, subscriber.className)} = makeExternalDurableObject(${JSON.stringify(subscriber)});`,
    ),
  ].join("\n");
  return formatInternalWorkerModules({
    modules: {
      "index.worker.mjs": main,
      ...RegistryProxyWorker.modules,
    },
  });
};
