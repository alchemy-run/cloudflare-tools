import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as LocalProxyWorker from "worker:./internal/local-proxy.worker.ts";
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
>()("LocalProxy") {}

export const LocalProxyConfig = Config.all({
  host: Config.string("LOCAL_PROXY_HOST").pipe(Config.withDefault("localhost")),
  port: Config.int("LOCAL_PROXY_PORT").pipe(Config.withDefault(1337)),
});

export const LocalProxyLive = Layer.effect(
  LocalProxy,
  Effect.gen(function* () {
    const config = yield* LocalProxyConfig;
    const runtime = yield* Runtime.Runtime;
    const http = yield* HttpClient.HttpClient;
    const port = yield* findAvailablePort(config.port, config.host);
    yield* runtime.serve({
      sockets: [
        {
          name: "http",
          address: `${config.host}:${port}`,
          service: { name: "proxy:local" },
        },
      ],
      services: [
        {
          name: "proxy:local",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: [{ name: LocalProxyWorker.name, esModule: LocalProxyWorker.code }],
          },
        },
      ],
    });
    const address = `http://${config.host}:${port}`;
    return LocalProxy.of({
      address: `http://${config.host}:${port}`,
      send: Effect.fn((message) =>
        http
          .post(new URL(LOCAL_CONFIGURE_PATH, address), {
            body: HttpBody.jsonUnsafe(message),
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.mapError(
              (e) => new ProxyError({ message: "Failed to send message to local proxy", cause: e }),
            ),
          ),
      ),
    });
  }),
);
