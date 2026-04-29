import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { convertWorkerModules } from "./internal/convert-worker-modules.ts";
import * as LocalProxy from "./proxy/LocalProxy.ts";
import type { ProxyError } from "./proxy/ProxyError.ts";
import type { Worker } from "./Worker.ts";
import * as Runtime from "./workerd/Runtime.ts";
import type { RuntimeError } from "./workerd/RuntimeError.ts";

export interface ServeResult {
  readonly name: string;
  readonly address: string;
}

export class Server extends Context.Service<
  Server,
  {
    readonly serve: (
      worker: Worker,
    ) => Effect.Effect<ServeResult, RuntimeError | ProxyError, Scope.Scope>;
  }
>()("cloudflare-runtime/Server") {}

export const ServerLive = Layer.effect(
  Server,
  Effect.gen(function* () {
    const runtime = yield* Runtime.Runtime;
    const localProxy = yield* LocalProxy.LocalProxy;
    return Server.of({
      serve: Effect.fn(function* (worker) {
        const result = yield* runtime.serve({
          sockets: [
            {
              name: "http",
              address: "127.0.0.1:0",
              service: { name: "user" },
            },
          ],
          services: [
            {
              name: "user",
              worker: {
                compatibilityDate: worker.compatibilityDate,
                compatibilityFlags: worker.compatibilityFlags,
                modules: convertWorkerModules(worker.modules),
                durableObjectNamespaces: worker.durableObjectNamespaces?.map((namespace) => ({
                  className: namespace.className,
                  enableSql: namespace.sql,
                  uniqueKey: namespace.uniqueKey,
                })),
              },
            },
          ],
        });
        yield* localProxy.send({
          _tag: "Local.Set",
          worker: worker.name,
          address: `http://localhost:${result[0].port}`,
        });
        yield* Effect.addFinalizer(() =>
          localProxy
            .send({
              _tag: "Local.Unset",
              worker: worker.name,
            })
            .pipe(Effect.ignore),
        );
        return {
          name: worker.name,
          address: `http://${worker.name}.${localProxy.address}`,
        };
      }),
    });
  }),
);
