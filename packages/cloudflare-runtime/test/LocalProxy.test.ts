import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Internet from "../src/globals/Internet.ts";
import * as LocalProxy from "../src/proxy/LocalProxy.ts";
import * as WorkerdConfig from "../src/workerd/Config.ts";
import * as Workerd from "../src/workerd/Workerd.ts";

const services = LocalProxy.LocalProxyLive(0).pipe(
  Layer.provideMerge(Layer.mergeAll(Workerd.WorkerdLive, Internet.InternetLive)),
  Layer.provide(NodeServices.layer),
);

layer(services)((it) => {
  it.effect(
    "proxies a websocket connection to the upstream worker",
    () =>
      Effect.gen(function* () {
        const workerd = yield* Workerd.Workerd;
        const proxy = yield* LocalProxy.LocalProxy;

        const upstreamPorts = yield* workerd.serve({
          sockets: [
            {
              name: "http",
              address: "127.0.0.1:0",
              service: { name: "upstream" },
            },
          ],
          services: [
            {
              name: "upstream",
              worker: {
                compatibilityDate: "2026-03-10",
                modules: [
                  {
                    name: "main.js",
                    esModule: `
export default {
  fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (event) => {
      server.send("echo:" + event.data);
      server.close(1000, "done");
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
`,
                  },
                ],
              },
            },
          ],
        });
        const upstreamAddress = `http://127.0.0.1:${upstreamPorts.http}`;

        const proxyAddress = yield* proxy.registerWorker("test");
        yield* proxy.setLocalAddress("test", upstreamAddress);

        const wsUrl = new URL(proxyAddress);
        wsUrl.protocol = "ws:";

        const result = yield* roundTrip(wsUrl, "hello");

        expect(result).toMatchObject({
          message: "echo:hello",
          closeCode: 1000,
          closeReason: "done",
        });
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "proxies a websocket connection to a durable object",
    () =>
      Effect.gen(function* () {
        const workerd = yield* Workerd.Workerd;
        const proxy = yield* LocalProxy.LocalProxy;

        const upstreamPorts = yield* workerd.serve({
          sockets: [
            {
              name: "http",
              address: "127.0.0.1:0",
              service: { name: "upstream" },
            },
          ],
          services: [
            {
              name: "upstream",
              worker: {
                compatibilityDate: "2026-03-10",
                modules: [
                  {
                    name: "main.js",
                    esModule: `
import { DurableObject } from "cloudflare:workers";

export class WSRoom extends DurableObject {
  fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, message) {
    ws.send("do-echo:" + message);
    ws.close(1000, "do-done");
  }
}

export default {
  fetch(request, env) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    return env.ROOM.get("room").fetch(request);
  },
};
`,
                  },
                ],
                bindings: [{ name: "ROOM", durableObjectNamespace: { className: "WSRoom" } }],
                durableObjectNamespaces: [
                  { className: "WSRoom", ephemeralLocal: WorkerdConfig.kVoid },
                ],
              },
            },
          ],
        });
        const upstreamAddress = `http://127.0.0.1:${upstreamPorts.http}`;

        const proxyAddress = yield* proxy.registerWorker("do-test");
        yield* proxy.setLocalAddress("do-test", upstreamAddress);

        const wsUrl = new URL(proxyAddress);
        wsUrl.protocol = "ws:";

        const result = yield* roundTrip(wsUrl, "ping");

        expect(result).toMatchObject({
          message: "do-echo:ping",
          closeCode: 1000,
          closeReason: "do-done",
        });
      }),
    { timeout: 30_000 },
  );
  it.effect(
    "proxies an HTTP request/response to the upstream worker",
    () =>
      Effect.gen(function* () {
        const workerd = yield* Workerd.Workerd;
        const proxy = yield* LocalProxy.LocalProxy;

        const upstreamPorts = yield* workerd.serve({
          sockets: [
            {
              name: "http",
              address: "127.0.0.1:0",
              service: { name: "upstream" },
            },
          ],
          services: [
            {
              name: "upstream",
              worker: {
                compatibilityDate: "2026-03-10",
                modules: [
                  {
                    name: "main.js",
                    esModule: `
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      const body = await request.text();
      return new Response("echo:" + body, {
        status: 200,
        headers: { "x-echo": "yes", "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/headers") {
      return Response.json({
        forwardedHost: request.headers.get("x-forwarded-host"),
        forwardedProto: request.headers.get("x-forwarded-proto"),
        host: request.headers.get("host"),
      });
    }
    return new Response("not found", { status: 404 });
  },
};
`,
                  },
                ],
              },
            },
          ],
        });
        const upstreamAddress = `http://127.0.0.1:${upstreamPorts.http}`;

        const proxyAddress = yield* proxy.registerWorker("http-test");
        yield* proxy.setLocalAddress("http-test", upstreamAddress);

        const response = yield* Effect.promise(() =>
          fetch(new URL("/echo", proxyAddress), {
            method: "POST",
            body: "hello",
          }).then(async (res) => ({
            status: res.status,
            echo: res.headers.get("x-echo"),
            body: await res.text(),
          })),
        );
        expect(response).toEqual({ status: 200, echo: "yes", body: "echo:hello" });

        const missing = yield* Effect.promise(() =>
          fetch(new URL("/missing", proxyAddress)).then(async (res) => ({
            status: res.status,
            body: await res.text(),
          })),
        );
        expect(missing).toEqual({ status: 404, body: "not found" });

        const proxyHost = new URL(proxyAddress).host;
        const headers = yield* Effect.promise(() =>
          fetch(new URL("/headers", proxyAddress)).then((res) => res.json()),
        );
        expect(headers).toMatchObject({
          forwardedHost: proxyHost,
          forwardedProto: "http",
        });
      }),
    { timeout: 30_000 },
  );
});

const roundTrip = (url: URL, payload: string) =>
  Effect.callback<{
    message: string;
    closeCode: number;
    closeReason: string;
  }>((resume) => {
    const ws = new WebSocket(url);
    let message: string | undefined;
    ws.addEventListener("open", () => {
      ws.send(payload);
    });
    ws.addEventListener("message", (event) => {
      message = String(event.data);
    });
    ws.addEventListener("close", (event) => {
      if (message === undefined) {
        resume(Effect.die(new Error("did not receive a message before close")));
      } else {
        resume(Effect.succeed({ message, closeCode: event.code, closeReason: event.reason }));
      }
    });
    ws.addEventListener("error", () => {
      resume(Effect.die(new Error("websocket error")));
    });
    return Effect.sync(() => {
      ws.close();
    });
  });
