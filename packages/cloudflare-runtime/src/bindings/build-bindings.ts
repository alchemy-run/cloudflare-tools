import type { PutScriptRequest } from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ServiceDesignator, Worker_Binding } from "../runtime/config.types.ts";
import type { RemoteBinding } from "./remote-session.ts";

export type Binding = Exclude<
  NonNullable<PutScriptRequest["metadata"]["bindings"]>[number],
  { type: "inherit" }
>;

class UnsupportedBindingError extends Data.TaggedError("UnsupportedBindingError")<{
  message: string;
  binding: Binding;
}> {}

export const buildBindings = Effect.fn(function* (bindings: Array<Binding>) {
  const remoteBindings: Array<RemoteBinding> = [];
  const workerBindings = yield* Effect.forEach(
    bindings,
    Effect.fn(
      function* (binding): Effect.fn.Return<Worker_Binding, UnsupportedBindingError> {
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
          case "hyperdrive":
            return yield* makeUnsupportedBindingError(binding);
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
          case "workflow":
            return yield* makeUnsupportedBindingError(binding);
        }
      },
      Effect.orElseSucceed(() => undefined),
    ),
    { concurrency: "unbounded" },
  );
  return {
    remoteBindings,
    workerBindings: workerBindings.filter((b) => b !== undefined),
  };
});

function makeUnsupportedBindingError(binding: Binding): UnsupportedBindingError {
  return new UnsupportedBindingError({
    message: `Unsupported binding: ${binding.type}`,
    binding,
  });
}

function makeRemoteBindingServiceDesignator(binding: string): ServiceDesignator {
  return {
    name: "remote-bindings:client",
    props: {
      json: JSON.stringify({ binding }),
    },
  };
}
