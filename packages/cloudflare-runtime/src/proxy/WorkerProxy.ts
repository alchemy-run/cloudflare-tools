import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ProxyWorker from "worker:./WorkerProxy.worker.ts";
import * as Internet from "../globals/Internet.ts";
import { findAvailablePort } from "../internal/find-available-port.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as Workerd from "../workerd/Workerd.ts";

export class WorkerProxy extends Context.Service<
  WorkerProxy,
  {
    readonly serve: (port: number) => Effect.Effect<WorkerProxyInstance, RuntimeError, Scope.Scope>;
  }
>()("cloudflare-runtime/proxy/WorkerProxy") {}

export interface WorkerProxyInstance {
  readonly url: URL;
  readonly set: (upstream: URL) => Effect.Effect<void, SystemError>;
  readonly unset: () => Effect.Effect<void, SystemError>;
}

export const WorkerProxyLive = Layer.effect(
  WorkerProxy,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const internet = yield* Internet.Internet;

    return WorkerProxy.of({
      serve: Effect.fn("WorkerProxy.serve")(function* (port) {
        const token = crypto.randomUUID();
        const ports = yield* workerd.serve({
          sockets: [
            {
              name: "http",
              address: `127.0.0.1:${yield* findAvailablePort(port, "127.0.0.1")}`,
              service: { name: "proxy:worker" },
            },
          ],
          services: [
            {
              name: "proxy:worker",
              worker: {
                compatibilityDate: "2026-03-10",
                modules: formatInternalWorkerModules(ProxyWorker),
                bindings: [
                  { name: "PROXY", durableObjectNamespace: { className: "WorkerProxy" } },
                  { name: "PROXY_TOKEN", text: token },
                ],
                durableObjectNamespaces: [
                  {
                    className: "WorkerProxy",
                    ephemeralLocal: WorkerdConfig.kVoid,
                    preventEviction: true,
                  },
                ],
              },
            },
            internet,
          ],
        });
        const url = new URL(`http://localhost:${ports.http}`);
        return {
          url,
          set: Effect.fn("WorkerProxyInstance.set")(function* (upstream) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/cdn-cgi/proxy/controller", url), {
                method: "PUT",
                headers: {
                  "Content-Type": "text/plain",
                  Authorization: `Bearer ${token}`,
                },
                body: upstream.toString(),
              }),
            );
            if (!response.ok) {
              return yield* new SystemError({
                subtag: "WorkerProxy.set",
                message: "Failed to set upstream",
                cause: response,
              });
            }
          }),
          unset: Effect.fn("WorkerProxyInstance.unset")(function* () {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/cdn-cgi/proxy/controller", url), {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              }),
            );
            if (!response.ok) {
              return yield* new SystemError({
                subtag: "WorkerProxy.unset",
                message: "Failed to unset upstream",
                cause: response,
              });
            }
          }),
        };
      }),
    });
  }),
);
