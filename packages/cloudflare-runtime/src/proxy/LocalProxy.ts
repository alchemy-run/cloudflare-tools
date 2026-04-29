import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as LocalProxyWorker from "worker:./internal/local-proxy.worker.ts";
import { convertWorkerModules } from "../internal/convert-worker-modules.ts";
import * as Runtime from "../workerd/Runtime.ts";
import { LOCAL_CONFIGURE_PATH, type ControllerMessage } from "./ProxyApi.ts";
import { ProxyError } from "./ProxyError.ts";
import { findAvailablePort } from "./internal/find-available-port.ts";

export class LocalProxy extends Context.Service<
  LocalProxy,
  {
    readonly address: string;
    readonly send: (message: ControllerMessage) => Effect.Effect<void, ProxyError>;
  }
>()("cloudflare-runtime/proxy/LocalProxy") {}

export interface LocalProxyConfig {
  readonly host: string;
  readonly port: number;
}

export const LocalProxyLive = (config: LocalProxyConfig) =>
  Layer.effect(
    LocalProxy,
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const http = yield* HttpClient.HttpClient;
      const result = yield* runtime.serve({
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
              modules: convertWorkerModules(LocalProxyWorker.modules),
            },
          },
        ],
      });
      const address = `${config.host}:${result[0].port}`;
      return LocalProxy.of({
        address,
        send: Effect.fn((message) =>
          http
            .post(new URL(LOCAL_CONFIGURE_PATH, `http://${config.host}:${result[0].port}`), {
              body: HttpBody.jsonUnsafe(message),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.mapError(
                (e) =>
                  new ProxyError({ message: "Failed to send message to local proxy", cause: e }),
              ),
            ),
        ),
      });
    }),
  );
