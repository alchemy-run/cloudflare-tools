import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { absurd } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ClientWorker from "worker:./workers/client.worker.ts";
import * as OutboundWorker from "worker:./workers/outbound.worker.ts";
import type * as Plugin from "../Plugin.ts";
import type * as Worker from "../Worker.ts";
import * as Config from "../workerd/Config.ts";
import * as WorkerModule from "../WorkerModule.ts";
import type { OutboundConfig, RemoteBinding, SessionOptions } from "./RemoteConfig.ts";
import * as RemoteSession from "./RemoteSession.ts";

export class UnsupportedBindingError extends Schema.TaggedErrorClass<UnsupportedBindingError>()(
  "UnsupportedBindingError",
  {
    message: Schema.String,
    binding: Schema.Any,
  },
) {}

export class Bindings extends Context.Service<Bindings, Plugin.Plugin<UnsupportedBindingError>>()(
  "cloudflare-runtime/bindings/Bindings",
) {}

export const layer = Layer.effect(
  Bindings,
  Effect.gen(function* () {
    const httpServer = yield* HttpServer.HttpServer;
    const remoteSession = yield* RemoteSession.RemoteSession;
    const prewarms = new Map<string, Fiber.Fiber<OutboundConfig, RemoteSession.SessionError>>();

    const address = httpServer.address as HttpServer.TcpAddress;

    const createSession = Effect.fn(function* (options: SessionOptions) {
      const fiber = prewarms.get(options.name);
      if (fiber) {
        prewarms.delete(options.name);
        return yield* Fiber.join(fiber);
      }
      const session = yield* remoteSession.create(options);
      return session;
    });

    yield* httpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const json = (yield* request.json) as unknown as SessionOptions;
        const session = yield* createSession(json);
        return yield* HttpServerResponse.json({ success: true, session });
      }),
    );

    const makeServices = (options: SessionOptions) => {
      const config = {
        name: "remote-bindings:config",
        external: {
          address: `${address.hostname}:${address.port}`,
          http: {},
        },
      } satisfies Config.Service;
      const outbound = {
        name: "remote-bindings:outbound",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: OutboundWorker.modules.map(WorkerModule.toWorkerd),
          bindings: [
            {
              name: "PROXY",
              durableObjectNamespace: { className: "RemoteBindingProxy" },
            },
            {
              name: "LOOPBACK",
              service: { name: config.name },
            },
            {
              name: "OPTIONS",
              json: JSON.stringify(options),
            },
          ],
          durableObjectNamespaces: [
            {
              className: "RemoteBindingProxy",
              enableSql: true,
              preventEviction: true,
              ephemeralLocal: Config.kVoid,
            },
          ],
        },
      } satisfies Config.Service;
      const client = {
        name: "remote-bindings:client",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: ClientWorker.modules.map(WorkerModule.toWorkerd),
          globalOutbound: { name: outbound.name },
        },
      } satisfies Config.Service;
      return [client, outbound, config];
    };

    return Bindings.of({
      name: "bindings",
      make: Effect.fn(function* (worker) {
        const { workerBindings, remoteBindings } = yield* buildBindings(worker.bindings);
        let services: Array<Config.Service> | undefined;
        if (remoteBindings.length > 0) {
          const options = {
            name: worker.name,
            bindings: remoteBindings,
          };
          prewarms.set(worker.name, yield* Effect.forkDetach(remoteSession.create(options)));
          services = makeServices(options);
        }
        return {
          bindings: workerBindings,
          services,
        };
      }),
    });
  }),
);

const buildBindings = Effect.fn(function* (bindings: ReadonlyArray<Worker.Binding>) {
  const remoteBindings: Array<RemoteBinding> = [];
  const workerBindings = yield* Effect.forEach(
    bindings,
    Effect.fn(function* (binding): Effect.fn.Return<
      Config.Worker_Binding,
      UnsupportedBindingError
    > {
      switch (binding.type) {
        case "ai": {
          remoteBindings.push({
            name: binding.name,
            type: "ai",
            raw: true,
          });
          return {
            name: binding.name,
            wrapped: {
              moduleName: "cloudflare-internal:ai-api",
              innerBindings: [
                {
                  name: "fetcher",
                  service: makeRemoteBindingServiceDesignator(binding.name),
                },
              ],
            },
          };
        }
        case "analytics_engine":
          return yield* makeUnsupportedBindingError(binding);
        case "artifacts": {
          remoteBindings.push({
            name: binding.name,
            // @ts-expect-error - TODO: add artifacts binding type to distilled.cloud/cloudflare/workers
            type: "artifacts",
            namespace: binding.namespace,
          });
          return {
            name: binding.name,
            service: makeRemoteBindingServiceDesignator(binding.name),
          };
        }
        case "assets":
          return yield* makeUnsupportedBindingError(binding);
        case "browser":
          return yield* makeUnsupportedBindingError(binding);
        case "d1": {
          remoteBindings.push({
            name: binding.name,
            type: "d1",
            id: binding.id,
            raw: true,
          });
          return {
            name: binding.name,
            wrapped: {
              moduleName: "cloudflare-internal:d1-api",
              innerBindings: [
                {
                  name: "fetcher",
                  service: makeRemoteBindingServiceDesignator(binding.name),
                },
              ],
            },
          };
        }
        case "data_blob": {
          return {
            name: binding.name,
            data: new TextEncoder().encode(binding.part),
          };
        }
        case "dispatch_namespace":
          return yield* makeUnsupportedBindingError(binding);
        case "durable_object_namespace": {
          if (binding.scriptName) {
            return yield* new UnsupportedBindingError({
              message: "Durable object namespace bindings must be linked to the current script.",
              binding,
            });
          }
          return {
            name: binding.name,
            durableObjectNamespace: { className: binding.className },
          };
        }
        case "hyperdrive": {
          // TODO: implement custom websocket transport
          // remoteBindings.push({
          //   name: binding.name,
          //   type: "hyperdrive",
          //   id: binding.id,
          // });
          // return {
          //   name: binding.name,
          //   hyperdrive: {
          //     designator: makeRemoteBindingServiceDesignator(binding.name),
          //     database: "",
          //     user: "",
          //     password: "",
          //     scheme: "",
          //   },
          // };
          return yield* makeUnsupportedBindingError(binding);
        }
        case "images": {
          remoteBindings.push({
            name: binding.name,
            type: "images",
            raw: true,
          });
          return {
            name: binding.name,
            wrapped: {
              moduleName: "cloudflare-internal:images-api",
              innerBindings: [
                {
                  name: "fetcher",
                  service: makeRemoteBindingServiceDesignator(binding.name),
                },
              ],
            },
          };
        }
        case "inherit":
          return yield* makeUnsupportedBindingError(binding);
        case "json": {
          return {
            name: binding.name,
            json: binding.json,
          };
        }
        case "kv_namespace": {
          remoteBindings.push({
            name: binding.name,
            type: "kv_namespace",
            namespaceId: binding.namespaceId,
            raw: true,
          });
          return {
            name: binding.name,
            kvNamespace: makeRemoteBindingServiceDesignator(binding.name),
          };
        }
        case "mtls_certificate":
          return yield* makeUnsupportedBindingError(binding);
        case "pipelines":
          return yield* makeUnsupportedBindingError(binding);
        case "plain_text": {
          return {
            name: binding.name,
            text: binding.text,
          };
        }
        case "queue": {
          // This makes the whole remote worker fail with 503 errors!
          // remoteBindings.push({
          //   name: binding.name,
          //   type: "queue",
          //   queueName: binding.queueName,
          //   raw: true,
          // });
          // return {
          //   name: binding.name,
          //   queue: makeServiceDesignator(binding.name),
          // };
          return yield* makeUnsupportedBindingError(binding);
        }
        case "r2_bucket": {
          remoteBindings.push({
            name: binding.name,
            type: "r2_bucket",
            bucketName: binding.bucketName,
            jurisdiction: binding.jurisdiction,
            raw: true,
          });
          return {
            name: binding.name,
            r2Bucket: makeRemoteBindingServiceDesignator(binding.name),
          };
        }
        case "secret_key":
          return yield* makeUnsupportedBindingError(binding);
        case "secret_text": {
          return {
            name: binding.name,
            text: binding.text,
          };
        }
        case "secrets_store_secret":
          return yield* makeUnsupportedBindingError(binding);
        case "send_email":
          return yield* makeUnsupportedBindingError(binding);
        case "service": {
          remoteBindings.push({
            name: binding.name,
            type: "service",
            service: binding.service,
            environment: binding.environment,
          });
          return {
            name: binding.name,
            service: makeRemoteBindingServiceDesignator(binding.name),
          };
        }
        case "text_blob": {
          return {
            name: binding.name,
            data: new TextEncoder().encode(binding.part),
          };
        }
        case "vectorize":
          return yield* makeUnsupportedBindingError(binding);
        case "version_metadata": {
          return {
            name: binding.name,
            json: JSON.stringify({
              id: crypto.randomUUID(),
              tag: "",
              timestamp: "0",
            }),
          };
        }
        case "wasm_module": {
          return {
            name: binding.name,
            wasmModule: new TextEncoder().encode(binding.part),
          };
        }
        case "worker_loader": {
          return {
            name: binding.name,
            workerLoader: {},
          };
        }
        case "workflow": {
          // remoteBindings.push({
          //   name: binding.name,
          //   type: "workflow",
          //   className: binding.className!,
          //   workflowName: binding.workflowName,
          //   scriptName: binding.scriptName,
          //   raw: true,
          // });
          return yield* makeUnsupportedBindingError(binding);
        }
        default:
          return absurd(binding);
      }
    }),
    { concurrency: "unbounded" },
  );
  return {
    remoteBindings,
    workerBindings: workerBindings.filter((b) => b !== undefined),
  };
});

function makeUnsupportedBindingError(binding: Worker.Binding): UnsupportedBindingError {
  return new UnsupportedBindingError({
    message: `Unsupported binding: ${binding.type}`,
    binding,
  });
}

function makeRemoteBindingServiceDesignator(binding: string): Config.ServiceDesignator {
  return {
    name: "remote-bindings:client",
    props: {
      json: JSON.stringify({ binding }),
    },
  };
}
