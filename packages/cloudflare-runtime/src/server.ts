import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Binding } from "./bindings/index.ts";
import * as Bindings from "./bindings/index.ts";
import * as Bridge from "./bridge/bridge.ts";
import { Entry } from "./entry/entry.ts";
import type { Worker_Module } from "./runtime/config.types.ts";
import * as Runtime from "./runtime/runtime.ts";

export interface ServeOptions {
  name: string;
  port: number;
}

export interface ServerInstance {
  readonly address: string;
  readonly update: (worker: {
    compatibilityDate: string;
    compatibilityFlags?: Array<string>;
    bindings: Array<Binding>;
    modules: Array<Worker_Module>;
  }) => Effect.Effect<void, unknown, Scope.Scope>;
}

export class Server extends Context.Service<
  Server,
  {
    readonly serve: (options: {
      name: string;
      port: number;
    }) => Effect.Effect<ServerInstance, Runtime.RuntimeError, Scope.Scope>;
  }
>()("Server") {}

export const ServerLive = Layer.effect(
  Server,
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const services = yield* Bindings.RemoteBindingsServices;
    const bridge = yield* Bridge.Bridge;
    const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
    return Server.of({
      serve: Effect.fn(function* ({ name, port }) {
        const local = yield* bridge.local(port);
        return {
          address: `http://localhost:${port}`,
          update: Effect.fn(function* (worker) {
            console.log("Updating server", worker);
            const { remoteBindings, workerBindings } = yield* Bindings.buildBindings(
              worker.bindings,
            );
            const remoteBindingsServices = yield* services.services({
              accountId,
              scriptName: name,
              bindings: remoteBindings,
            });
            const server = yield* runtime.serve({
              sockets: [
                {
                  name: "bridge",
                  address: "127.0.0.1:0",
                  service: { name: "entry" },
                },
              ],
              services: [
                {
                  name: "user",
                  worker: {
                    compatibilityDate: worker.compatibilityDate,
                    compatibilityFlags: worker.compatibilityFlags,
                    modules: worker.modules,
                    bindings: workerBindings,
                  },
                },
                yield* Entry,
                ...remoteBindingsServices,
              ],
            });
            const address = `http://localhost:${server[0].port}`;
            yield* local.configure({ type: "local.set", value: address });
            console.log("Updated server", address);
          }),
        };
      }),
    });
  }),
);
