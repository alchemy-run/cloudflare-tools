import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";
import http from "node:http";
import type { Duplex } from "node:stream";
import { rolldown } from "rolldown";
import * as Runtime from "./src/runtime/runtime";
import type {
  RpcAbort,
  RpcRequest,
  RpcResponse,
  RpcUpgradeWebSocket,
  RpcWebSocketClose,
  RpcWebSocketMessage,
} from "./src/workers/rpc.shared";

const BRIDGE_SECRET = "secret";

const bundle = Effect.fn(function* (entry: string) {
  return yield* Effect.promise(async () => {
    const bundle = await rolldown({
      input: entry,
      plugins: [cloudflare()],
    });
    const output = await bundle.generate({
      file: "worker.js",
      format: "esm",
      minify: false,
    });
    await bundle.close();
    return output;
  });
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
          compatibilityFlags: ["experimental"],
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
          const message: RpcUpgradeWebSocket = {
            type: "upgrade.websocket",
            id: json.id,
            data: {
              status: response.statusCode ?? 101,
              headers: response.headers as Record<string, string | Array<string>>,
            },
          };
          console.log(message);
          ws.send(JSON.stringify(message));
          if (head.length > 0) {
            const message: RpcWebSocketMessage = {
              type: "websocket.message",
              id: json.id,
              data: head.toString(),
            };
            console.log(message);
            ws.send(JSON.stringify(message));
          }
          socket.on("data", (chunk) => {
            const message: RpcWebSocketMessage = {
              type: "websocket.message",
              id: json.id,
              data: chunk.toString(),
            };
            console.log(message);
            ws.send(JSON.stringify(message));
          });
          socket.on("end", () => {
            sockets.delete(json.id);
            const message: RpcWebSocketClose = {
              type: "websocket.close",
              id: json.id,
              data: {
                code: 1000,
                reason: "Normal closure",
              },
            };
            console.log(message);
            ws.send(JSON.stringify(message));
          });
        });

        target.on("response", (response) => {
          console.log("response", response.statusCode, response.headers);
          let body = "";
          response.on("data", (chunk) => {
            body += chunk.toString();
          });
          response.on("end", () => {
            const message: RpcResponse = {
              type: "response",
              id: json.id,
              data: {
                status: response.statusCode ?? 200,
                headers: response.headers as Record<string, string | Array<string>>,
                body: body || null,
              },
            };
            console.log(message);
            ws.send(JSON.stringify(message));
          });
        });
        target.on("error", (error) => {
          const message: RpcResponse = {
            type: "response",
            id: json.id,
            data: {
              status: 500,
              headers: {},
              body: error.message,
            },
          };
          console.error(error);
          ws.send(JSON.stringify(message));
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
          const message: RpcResponse = {
            type: "response",
            id: json.id,
            data: {
              status: 500,
              headers: {},
              body: "Aborted",
            },
          };
          console.log(message);
          ws.send(JSON.stringify(message));
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
  program.pipe(
    Effect.scoped,
    Effect.provide(Runtime.RuntimeLive),
    Effect.provide(NodeServices.layer),
  ),
);
