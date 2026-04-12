import { kVoid } from "#/runtime/config.types";
import { bundle } from "#/utils/bundle";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";
import http from "node:http";
import type { Duplex } from "node:stream";
import * as Runtime from "./src/runtime/runtime";
import type {
  RpcAbort,
  RpcRequest,
  RpcResponse,
  RpcResponseChunk,
  RpcResponseEnd,
  RpcUpgradeWebSocket,
  RpcWebSocketClose,
  RpcWebSocketMessage,
} from "./src/workers/rpc.shared";

const BRIDGE_SECRET = "secret";

const bundleAsEsModule = Effect.fn(function* (entry: string) {
  const { output } = yield* bundle(entry);
  return {
    name: "worker.js",
    esModule: output[0].code,
  };
});

const remoteProxyClient = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  Bun.serve({
    port: 42069,
    fetch: async () => {
      const config = {
        url: "https://remote-bridge.johnroyal.workers.dev",
        headers: {
          "cf-workers-preview-token":
            "Ab2xmwkrgWsGn5y0ov32y7H0uL8iHJtezxH1JUVOMIl3Ik7B_-cUxakDehm96g2ild8eWbK3SK_E0E352rXQC7LaExEQJ703pmPOKYdwVbbgS0LvkHXtbQoXMNCxLf9dD9BY-k4PsJDIcL5n_hvyvg4dmr6VAsB52n5ljys3tYusDXs5dXa1lIkjYYev_R3Gp7C8KJq1VDsSJFPY9sLKjXeUoIgGOTWoxjz1k9WQShTHR5COm7DctT5osEt4NfsjdDxH8NNj-wGlabycQ3TFNOXwlzpG3JT_CPG7vno1G1J-_X9kaRXxCe3gFvCFmi-ORCb3ACJVVMX3IkmQXJ9kSG1ptxsFUSAz0EenYdBjvZcC5Msg4YwZT8Gt9LetIOMNe8egAQdn6V85mf-wM6ZwUO731EN2TaXBFm_RIyUl4vtb_-fXfT9D66UBOQfdBc6LLK_kIaud0I-fScowXmH_QucLYgjQ37CxzATMyPqH2jLi_2PmIx5O_GFfeVcSgwD90yBAhAtt2f1VZ6NoemGylhlVGtOhN0H71iFmZM3Rb2hSSqOf-Pb5Mo9Wg6pnwYd3vknpBYQZ0F0B_SE-ZUNQIfi11y_DdsYgwqFuWTsTu8b-4Gh9m6mDBcgawRjb-OtIIF6SDPHnFZ67G-X6KdbKnIBKm4-uABP4HX5Rwy9RKL4Lpm1TnYzNtQs9nRj16xHFnbzu-ZMKVBZxFRHvvjOsxtxZsn6sSPxcaKFwa434PVHmGCuvTUyeW0izRWWC2cA7LuQbZYu1aPzNIFoZYU9zD_br11eOZNVJOrGmXEPHlfZlnjigUuVX9JPBezNblciDnNLDzoxxbdJCHIHw6GIeWfIgVmzddsjA2aEAIO4w_Dee",
        },
      };
      // const config = await Effect.runPromise(
      //   createPreview({
      //     name: "remote-bridge",
      //     host: undefined,
      //     zoneId: undefined,
      //     bindings: [
      //       {
      //         name: "KV",
      //         type: "kv_namespace",
      //         namespaceId: "c2399b3754ea4199a765e8c388eb2603",
      //         raw: true,
      //       },
      //     ],
      //   }),
      // );
      console.log("config", config);
      return Response.json(config);
    },
  });
  yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:1337",
        service: { name: "kv-test" },
      },
    ],
    services: [
      {
        name: "kv-test",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [yield* bundleAsEsModule("src/workers/kv-test.worker.ts")],
          bindings: [
            {
              name: "KV",
              kvNamespace: {
                name: "remote-proxy:client",
                props: {
                  json: JSON.stringify({
                    binding: "KV",
                  }),
                },
              },
            },
          ],
        },
      },
      {
        name: "remote-proxy:client",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [yield* bundleAsEsModule("src/remote/workers/remote-proxy-client.worker.ts")],
          globalOutbound: { name: "remote-proxy:outbound" },
        },
      },
      {
        name: "remote-proxy:outbound",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [yield* bundleAsEsModule("src/remote/workers/remote-proxy-outbound.worker.ts")],
          bindings: [
            {
              name: "PROXY",
              durableObjectNamespace: { className: "RemoteBindingProxy" },
            },
            {
              name: "LOOPBACK",
              service: { name: "loopback" },
            },
          ],
          durableObjectNamespaces: [
            {
              className: "RemoteBindingProxy",
              enableSql: true,
              preventEviction: true,
              ephemeralLocal: kVoid,
            },
          ],
        },
      },
      {
        name: "loopback",
        external: {
          address: "localhost:42069",
          http: {},
        },
      },
    ],
  });
  console.log("done");
  yield* Effect.never;
});

const remote = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const path = yield* Path;
  const { output } = yield* bundle("src/workers/remote-bridge.worker.ts");
  return yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:1337",
        service: { name: "remote-bridge" },
      },
    ],
    services: [
      {
        name: "remote-bridge",
        worker: {
          compatibilityDate: "2026-03-10",
          compatibilityFlags: ["enable_request_signal"],
          modules: [
            {
              name: "remote-bridge",
              esModule: output[0].code,
            },
          ],
          bindings: [
            { name: "REMOTE_BRIDGE", durableObjectNamespace: { className: "RemoteBridge" } },
            { name: "BRIDGE_SECRET", text: BRIDGE_SECRET },
          ],
          durableObjectNamespaces: [{ className: "RemoteBridge", uniqueKey: "remote-bridge" }],
          durableObjectStorage: {
            localDisk: "storage:disk",
          },
        },
      },
      {
        name: "storage:disk",
        disk: {
          path: path.resolve("out"),
          writable: true,
        },
      },
    ],
  });
});

const local = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const worker = yield* bundle("src/workers/hello-world.worker.ts");
  return yield* runtime.serve({
    sockets: [
      {
        name: "http",
        address: "127.0.0.1:1338",
        service: { name: "worker" },
      },
    ],
    services: [
      {
        name: "worker",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: [
            {
              name: "worker",
              esModule: worker.output[0].code,
            },
          ],
        },
      },
    ],
  });
});

const program = Effect.gen(function* () {
  const output2 = yield* local;
  const output1 = yield* remote;
  console.log(output1, output2);
  const ws = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new WebSocket("ws://127.0.0.1:1337", {
          headers: { Authorization: `Bearer ${BRIDGE_SECRET}` },
        }),
    ),
    (ws) => Effect.sync(() => ws.close()),
  );
  const requests = new Map<string, http.ClientRequest>();
  const sockets = new Map<string, Duplex>();
  const send = (
    message:
      | RpcUpgradeWebSocket
      | RpcWebSocketMessage
      | RpcWebSocketClose
      | RpcResponse
      | RpcResponseChunk
      | RpcResponseEnd,
  ) => {
    console.log("send", message);
    ws.send(JSON.stringify(message));
  };
  ws.onmessage = (event) => {
    console.log("message", event.data);
    const json = JSON.parse(event.data) as
      | RpcRequest
      | RpcAbort
      | RpcWebSocketMessage
      | RpcWebSocketClose;
    switch (json.type) {
      case "request": {
        const url = new URL(json.data.url);
        const options: http.RequestOptions = {
          host: "localhost",
          port: 1338,
          path: url.pathname + url.search,
          method: json.data.method,
          headers: json.data.headers,
        };
        const target = http.request(options);
        requests.set(json.id, target);

        // this doesn't work in Bun :(
        target.on("upgrade", (response, socket, head) => {
          console.log("upgraded", json.id);
          sockets.set(json.id, socket);
          send({
            type: "websocket.upgrade",
            id: json.id,
            data: {
              status: response.statusCode ?? 101,
              headers: response.headers as Record<string, string | Array<string>>,
            },
          });
          if (head.length > 0) {
            send({ type: "websocket.message", id: json.id, data: head.toString() });
          }
          socket.on("data", (chunk) => {
            send({ type: "websocket.message", id: json.id, data: chunk.toString() });
          });
          socket.on("end", () => {
            sockets.delete(json.id);
            send({
              type: "websocket.close",
              id: json.id,
              data: { code: 1000, reason: "Normal closure" },
            });
          });
        });

        target.on("response", (response) => {
          send({
            type: "response",
            id: json.id,
            data: {
              status: response.statusCode ?? 200,
              headers: response.headers as Record<string, string | Array<string>>,
            },
          });
          response.on("data", (chunk) => {
            send({ type: "response.chunk", id: json.id, data: chunk.toString() });
          });
          response.on("end", () => {
            send({ type: "response.end", id: json.id });
          });
        });
        target.on("error", (error) => {
          send({
            type: "response",
            id: json.id,
            data: { status: 500, headers: {}, body: error.message },
          });
          requests.delete(json.id);
        });
        if (json.data.headers.upgrade === "websocket") {
          console.log("waiting for upgrade", json.id);
          target.end();
        } else {
          target.end(json.data.body);
        }
        break;
      }
      case "abort": {
        const request = requests.get(json.id);
        if (request) {
          request.destroy(new Error("Aborted"));
          send({ type: "response", id: json.id, data: { status: 500, headers: {}, body: null } });
        }
        break;
      }
      case "websocket.message": {
        const socket = sockets.get(json.id);
        if (socket) {
          socket.write(json.data);
        }
        break;
      }
      case "websocket.close": {
        console.log("websocket.close", json.id);
        const socket = sockets.get(json.id);
        if (socket) {
          socket.end(new Error(`${json.data.code} ${json.data.reason}`));
          sockets.delete(json.id);
        }
        break;
      }
    }
  };
  ws.onopen = () => {
    console.log("Connected to remote bridge");
  };
  ws.onclose = () => {
    console.log("Disconnected from remote bridge");
  };
  yield* Effect.never;
});

NodeRuntime.runMain(
  remoteProxyClient.pipe(
    Effect.scoped,
    Effect.provide(Runtime.RuntimeLive),
    Effect.provide(NodeServices.layer),
  ),
);
