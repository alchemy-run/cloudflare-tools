import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Internet from "../../src/globals/Internet.ts";
import * as WorkerProxy from "../../src/proxy/WorkerProxy.ts";
import * as Workerd from "../../src/workerd/Workerd.ts";

const services = WorkerProxy.WorkerProxyLive.pipe(
  Layer.provideMerge(Layer.mergeAll(Workerd.WorkerdLive, Internet.InternetLive)),
  Layer.provide(NodeServices.layer),
);

const HTTP_WORKER = `
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
      });
    }
    return new Response("not found", { status: 404 });
  },
};
`;

const WS_WORKER = `
export default {
  fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    server.addEventListener("message", (event) => {
      server.send("echo:" + event.data);
      server.close(1000, "done");
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};
`;

const serveUpstream = (esModule: string) =>
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const ports = yield* workerd.serve({
      sockets: [{ name: "http", address: "127.0.0.1:0", service: { name: "upstream" } }],
      services: [
        {
          name: "upstream",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: [{ name: "main.js", esModule }],
          },
        },
      ],
    });
    return new URL(`http://127.0.0.1:${ports.http}`);
  });

layer(services)((it) => {
  it.effect(
    "proxies an HTTP request/response to the upstream worker once a target is set",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const upstream = yield* serveUpstream(HTTP_WORKER);
        const instance = yield* proxy.serve(0);
        yield* instance.set(upstream);

        const echo = yield* Effect.promise(() =>
          fetch(new URL("/echo", instance.url), { method: "POST", body: "hello" }).then(
            async (res) => ({
              status: res.status,
              echo: res.headers.get("x-echo"),
              body: await res.text(),
            }),
          ),
        );
        expect(echo).toEqual({ status: 200, echo: "yes", body: "echo:hello" });

        const missing = yield* Effect.promise(() =>
          fetch(new URL("/missing", instance.url)).then(async (res) => ({
            status: res.status,
            body: await res.text(),
          })),
        );
        expect(missing).toEqual({ status: 404, body: "not found" });
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "forwards x-forwarded-host and x-forwarded-proto headers to the upstream worker",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const upstream = yield* serveUpstream(HTTP_WORKER);
        const instance = yield* proxy.serve(0);
        yield* instance.set(upstream);

        const headers = yield* Effect.promise(() =>
          fetch(new URL("/headers", instance.url)).then((res) => res.json()),
        );
        expect(headers).toMatchObject({
          forwardedHost: instance.url.host,
          forwardedProto: "http",
        });
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "re-targets requests to a new upstream after set is called again",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const first = yield* serveUpstream(
          `export default { fetch: () => new Response("first") };`,
        );
        const second = yield* serveUpstream(
          `export default { fetch: () => new Response("second") };`,
        );
        const instance = yield* proxy.serve(0);

        yield* instance.set(first);
        const a = yield* Effect.promise(() => fetch(instance.url).then((res) => res.text()));
        expect(a).toBe("first");

        yield* instance.set(second);
        const b = yield* Effect.promise(() => fetch(instance.url).then((res) => res.text()));
        expect(b).toBe("second");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "proxies a websocket connection to the upstream worker",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const upstream = yield* serveUpstream(WS_WORKER);
        const instance = yield* proxy.serve(0);
        yield* instance.set(upstream);

        const wsUrl = new URL(instance.url);
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
    "rejects controller requests with a missing or invalid authorization token",
    () =>
      Effect.gen(function* () {
        const proxy = yield* WorkerProxy.WorkerProxy;
        const instance = yield* proxy.serve(0);
        const controllerUrl = new URL("/cdn-cgi/proxy/controller", instance.url);

        const noAuth = yield* Effect.promise(() =>
          fetch(controllerUrl, {
            method: "PUT",
            headers: { "Content-Type": "text/plain" },
            body: "http://127.0.0.1:9999",
          }).then((res) => res.status),
        );
        expect(noAuth).toBe(401);

        const badAuth = yield* Effect.promise(() =>
          fetch(controllerUrl, {
            method: "PUT",
            headers: { "Content-Type": "text/plain", Authorization: "Bearer wrong-token" },
            body: "http://127.0.0.1:9999",
          }).then((res) => res.status),
        );
        expect(badAuth).toBe(401);
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
