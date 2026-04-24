import type { Worker_Module } from "@distilled.cloud/workerd/Config";
import * as Runtime from "@distilled.cloud/workerd/Runtime";
import { RuntimeError } from "@distilled.cloud/workerd/RuntimeError";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Bindings from "../bindings/index.ts";
import * as Bridge from "../bridge/bridge.ts";
import { Entry } from "../entry/entry.ts";
import * as Storage from "../storage.ts";

export interface ServeInput {
  storage: string;
}

export interface WorkerInput {
  name: string;
  accountId: string;
  compatibilityDate: string;
  compatibilityFlags: Array<string>;
  bindings: Array<Bindings.Binding>;
  durableObjectNamespaces: Array<DurableObjectNamespaceInput>;
  modules: Array<Worker_Module>;
}

export interface DurableObjectNamespaceInput {
  className: string;
  sql: boolean;
  uniqueKey: string;
}

export const ServeResult = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
});
export type ServeResult = typeof ServeResult.Type;

export const ServeError = Schema.Union([
  RuntimeError,
  Bridge.BridgeError,
  Bindings.UnsupportedBindingError,
]);
export type ServeError = RuntimeError | Bridge.BridgeError | Bindings.UnsupportedBindingError;

export const Server = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const services = yield* Bindings.RemoteBindingsServices;
  const bridge = yield* Bridge.LocalBridge;
  const storage = yield* Storage.Storage;

  const make = Effect.fn(function* (worker: WorkerInput) {
    const { remoteBindings, workerBindings } = yield* Bindings.buildBindings(worker.bindings);
    const remoteBindingsServices = yield* services.services({
      accountId: worker.accountId,
      scriptName: worker.name,
      bindings: remoteBindings,
    });
    const entry = yield* Entry;
    const server = yield* runtime.serve({
      sockets: [
        {
          name: "entry",
          address: "127.0.0.1:0",
          service: { name: entry.name },
        },
      ],
      services: [
        entry,
        {
          name: "user",
          worker: {
            compatibilityDate: worker.compatibilityDate,
            compatibilityFlags: worker.compatibilityFlags as Array<string>,
            modules: worker.modules,
            bindings: workerBindings,
            durableObjectNamespaces: worker.durableObjectNamespaces?.map((namespace) => ({
              className: namespace.className,
              enableSql: namespace.sql,
              uniqueKey: namespace.uniqueKey,
            })),
            durableObjectStorage: {
              localDisk: storage.name,
            },
          },
        },
        storage,
        ...remoteBindingsServices,
      ],
    });
    return { address: `http://localhost:${server[0].port}` };
  });

  const parent = yield* Effect.scope;
  const scopes = new Map<string, Scope.Closeable>();

  const stop = Effect.fn(function* (name: string) {
    const child = scopes.get(name);
    if (child) {
      yield* bridge.send({
        name,
        type: "local.unset",
      });
      yield* Scope.close(child, Exit.void);
      scopes.delete(name);
    }
  });

  const start = Effect.fn(function* (worker: WorkerInput) {
    yield* stop(worker.name);
    const child = yield* Scope.fork(parent);
    scopes.set(worker.name, child);
    const { address } = yield* make(worker).pipe(Scope.provide(child));
    yield* bridge.send({
      name: worker.name,
      type: "local.set",
      value: address,
    });
    return {
      name: worker.name,
      address: `http://${worker.name}.localhost:${bridge.port}`,
    } satisfies ServeResult;
  });

  return {
    start,
    stop,
  };
});
