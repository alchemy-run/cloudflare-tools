import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DurableObjectNamespace from "../../src/bindings/DurableObjectNamespace.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
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
  async fetch(_request, env) {
    const id = env.COUNTER.idFromName("singleton");
    return env.COUNTER.get(id).fetch("https://do.invalid/");
  },
};
`;

layer(localRuntimeLayer)("DurableObjectNamespace binding", (it) => {
  it.effect("persists state across invocations of the same durable object", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "durable-object-binding",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [DurableObjectNamespace.local({ binding: "COUNTER", className: "Counter" })],
        modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
        durableObjectNamespaces: [{ className: "Counter", sql: false, uniqueKey: "test-counter" }],
      });

      const first = yield* fetch("/");
      expect(yield* Effect.promise(() => first.text())).toBe("1");
      const second = yield* fetch("/");
      expect(yield* Effect.promise(() => second.text())).toBe("2");
    }),
  );
});
