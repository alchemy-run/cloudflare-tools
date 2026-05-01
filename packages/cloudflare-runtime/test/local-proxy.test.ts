import * as http from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "../src/workerd/Runtime.ts";

const services = Layer.provide(Runtime.layer, NodeServices.layer);

/**
 * Spin up a tiny loopback HTTP server that workerd workers can target.
 * Returns the bound port and a cleanup function.
 */
const startLoopbackTarget = (
  body: string,
): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to bind loopback target"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });

const proxyWorkerScript = (targetPort: number) => `
  export default {
    async fetch(request) {
      try {
        const r = await fetch("http://127.0.0.1:${targetPort}/");
        const text = await r.text();
        return new Response("ok:" + r.status + ":" + text);
      } catch (e) {
        return new Response(
          "err:" + (e?.code || e?.name || "?") + ":" + (e?.message || String(e)),
          { status: 500 },
        );
      }
    },
  };
`;

const fetchWorker = async (port: number): Promise<string> => {
  const r = await fetch(`http://127.0.0.1:${port}/`);
  return r.text();
};

layer(services)((it) => {
  /**
   * Without `globalOutbound`, workerd applies its default outbound
   * policy which denies loopback fetches. This test pins the failure
   * mode so a regression that "removes the globalOutbound, things
   * still seem to work" gets caught — without the binding the worker's
   * `fetch("http://127.0.0.1:…")` returns a network error.
   */
  it.effect(
    "without globalOutbound, a worker cannot fetch a loopback target",
    () =>
      Effect.gen(function* () {
        const target = yield* Effect.promise(() =>
          startLoopbackTarget("loopback-payload"),
        );
        try {
          const runtime = yield* Runtime.Runtime;
          const result = yield* runtime.serve({
            sockets: [
              {
                name: "http",
                address: "127.0.0.1:0",
                service: { name: "proxy" },
              },
            ],
            services: [
              {
                name: "proxy",
                worker: {
                  compatibilityDate: "2026-03-10",
                  modules: [
                    {
                      name: "main.js",
                      esModule: proxyWorkerScript(target.port),
                    },
                  ],
                },
              },
            ],
          });
          const port = result[0].port;
          const body = yield* Effect.promise(() => fetchWorker(port));
          expect(body.startsWith("err:")).toBe(true);
        } finally {
          yield* Effect.promise(() => target.close());
        }
      }),
  );

  /**
   * Setting `globalOutbound: { name: "internet" }` routes the worker's
   * outbound through a `network` service whose allow-list covers
   * private (incl. loopback) addresses, so the fetch succeeds. This is
   * what the LocalProxy change in `proxy/LocalProxy.ts` enables for
   * the proxy:local worker — without it, the local-proxy worker can't
   * reach user-registered front-proxies on `127.0.0.1`, surfacing on
   * Windows as workerd `WSARecv #64` and 500s on the friendly URL.
   */
  it.effect(
    "with globalOutbound -> internet, a worker can fetch a loopback target",
    () =>
      Effect.gen(function* () {
        const target = yield* Effect.promise(() =>
          startLoopbackTarget("loopback-payload"),
        );
        try {
          const runtime = yield* Runtime.Runtime;
          const result = yield* runtime.serve({
            sockets: [
              {
                name: "http",
                address: "127.0.0.1:0",
                service: { name: "proxy" },
              },
            ],
            services: [
              {
                name: "proxy",
                worker: {
                  compatibilityDate: "2026-03-10",
                  modules: [
                    {
                      name: "main.js",
                      esModule: proxyWorkerScript(target.port),
                    },
                  ],
                  globalOutbound: { name: "internet" },
                },
              },
              {
                name: "internet",
                network: {
                  allow: ["public", "private", "240.0.0.0/4"],
                  deny: [],
                  tlsOptions: { trustBrowserCas: true },
                },
              },
            ],
          });
          const port = result[0].port;
          const body = yield* Effect.promise(() => fetchWorker(port));
          expect(body).toBe("ok:200:loopback-payload");
        } finally {
          yield* Effect.promise(() => target.close());
        }
      }),
  );
});
