import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Bridge from "../bridge/bridge.ts";
import type { Bindings, Runtime } from "../index.ts";
import * as Server from "../server/Server.ts";
import { bundleOutputToWorkerd } from "../utils/bundle.ts";
import * as Bundle from "../utils/bundle.vendor.ts";
import * as Lock from "./Lock.ts";

export interface WorkerInputWithMain extends Omit<Server.WorkerInput, "modules"> {
  main: string;
}

export const RpcSchema = {
  heartbeat: { success: Schema.Void, error: Lock.LockError },
  shutdown: { success: Schema.Void, error: Lock.LockError },
  serve: { success: Server.ServeResult, error: Server.ServeError },
  stop: { success: Schema.Void, error: Bridge.BridgeError },
} as const;

export const DevServer = Effect.gen(function* () {
  const lock = yield* Lock.Lock;
  const server = yield* Server.Server;
  const fibers = new Map<string, Fiber.Fiber<void, Server.ServeError>>();
  const scope = yield* Effect.scope;

  const stop = Effect.fn(function* (name: string) {
    yield* server.stop(name);
    const fiber = fibers.get(name);
    if (fiber) {
      yield* Fiber.interrupt(fiber);
      fibers.delete(name);
    }
  });

  return {
    heartbeat: () => lock.touch,
    serve: Effect.fn(function* (worker: WorkerInputWithMain) {
      yield* stop(worker.name);
      const deferred = yield* Deferred.make<
        Server.ServeResult,
        Runtime.RuntimeError | Bridge.BridgeError | Bindings.UnsupportedBindingError
      >();
      const fiber = yield* Bundle.watch({
        input: import.meta.resolve(`../../${worker.main}`, import.meta.url),
        plugins: [
          cloudflare({
            compatibilityDate: worker.compatibilityDate,
            compatibilityFlags: worker.compatibilityFlags,
          }),
        ],
      }).pipe(
        Stream.filterMap(identity),
        Stream.mapEffect(bundleOutputToWorkerd),
        Stream.mapEffect((modules) =>
          server
            .start({
              name: worker.name,
              accountId: worker.accountId,
              compatibilityDate: worker.compatibilityDate,
              compatibilityFlags: worker.compatibilityFlags as Array<string>,
              bindings: worker.bindings,
              durableObjectNamespaces: worker.durableObjectNamespaces,
              modules,
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) => Deferred.complete(deferred, exit)),
            ),
        ),
        Stream.runDrain,
        Effect.forkScoped,
        Scope.provide(scope),
      );
      fibers.set(worker.name, fiber);
      const result = yield* Deferred.await(deferred);
      console.log("result", result);
      return result;
    }),
    stop,
    shutdown: () => {
      console.log("shutdown");
      return lock.release;
    },
  };
});
export type DevServer = Effect.Success<typeof DevServer>;
