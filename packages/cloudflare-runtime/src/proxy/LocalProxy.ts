import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as LocalProxyWorker from "worker:./workers/local-proxy.worker.ts";
import * as Internet from "../globals/Internet.ts";
import { findAvailablePort } from "../internal/find-available-port.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import { moduleToWorkerd } from "../RuntimeWorker.ts";
import * as Config from "../workerd/Config.ts";
import * as Workerd from "../workerd/Workerd.ts";
import { LOCAL_CONFIGURE_PATH, type ControllerMessage } from "./ProxyApi.shared.ts";

export class LocalProxy extends Context.Service<
  LocalProxy,
  {
    readonly address: string;
    readonly send: (message: ControllerMessage) => Effect.Effect<void, SystemError>;
  }
>()("cloudflare-runtime/proxy/LocalProxy") {}

export interface LocalProxyConfig {
  readonly host: string;
  readonly port: number;
}

export const layerLive = (config: LocalProxyConfig) =>
  Layer.effect(
    LocalProxy,
    Effect.gen(function* () {
      const runtime = yield* Workerd.Workerd;
      const http = yield* HttpClient.HttpClient;
      const ports = yield* runtime.serve({
        sockets: [
          {
            name: "http",
            address: `${config.host}:${yield* findAvailablePort(config.port, config.host)}`,
            service: { name: "proxy:local" },
          },
        ],
        services: [
          {
            name: "proxy:local",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: LocalProxyWorker.modules.map(moduleToWorkerd),
              bindings: [{ name: "PROXY", durableObjectNamespace: { className: "LocalProxy" } }],
              durableObjectNamespaces: [
                { className: "LocalProxy", ephemeralLocal: Config.kVoid, preventEviction: true },
              ],
            },
          },
          yield* Internet.Internet,
        ],
      });
      const address = `${config.host}:${ports.http}`;
      return LocalProxy.of({
        address,
        send: Effect.fn((message) =>
          http
            .post(new URL(LOCAL_CONFIGURE_PATH, `http://${address}`), {
              body: HttpBody.jsonUnsafe(message),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.mapError(
                (e) =>
                  new SystemError({
                    subtag: "LocalProxyControlPlane",
                    message: "Failed to send message to the local proxy controller.",
                    cause: e,
                  }),
              ),
            ),
        ),
      });
    }),
  );
