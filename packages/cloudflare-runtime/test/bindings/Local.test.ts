import { layer, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Data from "../../src/bindings/Data.ts";
import * as DurableObjectNamespace from "../../src/bindings/DurableObjectNamespace.ts";
import * as Json from "../../src/bindings/Json.ts";
import * as Loopback from "../../src/bindings/Loopback.ts";
import * as Text from "../../src/bindings/Text.ts";
import * as UnsafeEval from "../../src/bindings/UnsafeEval.ts";
import * as VersionMetadata from "../../src/bindings/VersionMetadata.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const ROUTER_SCRIPT = `
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async fetch() {
    const prev = (await this.ctx.storage.get("c")) ?? 0;
    const next = prev + 1;
    await this.ctx.storage.put("c", next);
    return new Response(String(next));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/text":
        return new Response(env.TEXT);
      case "/data":
        return new Response(env.DATA, { headers: { "content-type": "application/octet-stream" } });
      case "/json":
        return Response.json(env.JSON);
      case "/meta":
        return Response.json({
          hasId: typeof env.META.id === "string" && env.META.id.length > 0,
          tag: env.META.tag,
          timestamp: env.META.timestamp,
        });
      case "/eval":
        return new Response(String(env.EVAL.eval("1 + 2")));
      case "/loopback":
        return await env.LOOPBACK.fetch("https://loopback.invalid/echo");
      case "/do": {
        const id = env.COUNTER.idFromName("singleton");
        return env.COUNTER.get(id).fetch("https://do.invalid/");
      }
    }
    return new Response("not found", { status: 404 });
  },
};
`;

layer(localRuntimeLayer)("local bindings", (it) => {
  it.effect(
    "exposes every local binding type via fixture routes",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startTestWorker({
          name: "local-bindings",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            Text.binding("TEXT", "hello-text"),
            Data.binding("DATA", new Uint8Array([1, 2, 3, 4])),
            Json.binding("JSON", { a: 1, b: ["c", "d"] }),
            VersionMetadata.binding("META"),
            UnsafeEval.binding("EVAL"),
            Loopback.binding("LOOPBACK", (_req, res) => {
              res.writeHead(200, { "content-type": "text/plain" });
              res.end("loopback-ok");
            }),
            DurableObjectNamespace.local({ name: "COUNTER", className: "Counter" }),
          ] as const,
          modules: [{ name: "main.js", type: "ESModule", content: ROUTER_SCRIPT }],
          durableObjectNamespaces: [
            { className: "Counter", sql: false, uniqueKey: "test-counter" },
          ],
        });

        const text = yield* fetch("/text");
        expect(yield* Effect.promise(() => text.text())).toBe("hello-text");

        const data = yield* fetch("/data");
        const dataBytes = new Uint8Array(yield* Effect.promise(() => data.arrayBuffer()));
        expect(Array.from(dataBytes)).toEqual([1, 2, 3, 4]);

        const json = yield* fetch("/json");
        expect(yield* Effect.promise(() => json.json())).toEqual({ a: 1, b: ["c", "d"] });

        const meta = yield* fetch("/meta");
        expect(yield* Effect.promise(() => meta.json())).toEqual({
          hasId: true,
          tag: "",
          timestamp: "0",
        });

        const evalRes = yield* fetch("/eval");
        expect(yield* Effect.promise(() => evalRes.text())).toBe("3");

        const loopback = yield* fetch("/loopback");
        expect(loopback.status).toBe(200);
        expect(yield* Effect.promise(() => loopback.text())).toBe("loopback-ok");

        const do1 = yield* fetch("/do");
        expect(yield* Effect.promise(() => do1.text())).toBe("1");
        const do2 = yield* fetch("/do");
        expect(yield* Effect.promise(() => do2.text())).toBe("2");
      }),
    { timeout: 60_000 },
  );
});
