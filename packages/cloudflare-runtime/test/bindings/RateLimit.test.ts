import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RateLimit from "../../src/bindings/rate-limit/RateLimit.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const RATE_LIMIT_SCRIPT = `
export default {
  async fetch(request, env) {
    const { success } = await env.TESTRATE.limit({ key: "test" });
    if (!success) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response("success", { status: 200 });
  },
};
`;

const RATE_LIMIT_VALIDATION_SCRIPT = `
export default {
  async fetch(request, env) {
    const options = await request.json();
    try {
      await env.TESTRATE.limit(options);
    } catch (e) {
      return new Response(String(e), { status: 200 });
    }
    return new Response("should have resulted in error", { status: 500 });
  },
};
`;

layer(localRuntimeLayer)("RateLimit binding", (it) => {
  it.effect("limits requests once the configured threshold is reached", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "ratelimit-test",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: RATE_LIMIT_SCRIPT }],
        bindings: [
          RateLimit.local({
            binding: "TESTRATE",
            namespaceId: 1,
            simple: { limit: 2, period: 60 },
          }),
        ],
      });

      let res = yield* fetch("/");
      expect(res.status).toBe(200);
      expect(yield* Effect.promise(() => res.text())).toBe("success");

      res = yield* fetch("/");
      expect(res.status).toBe(200);
      expect(yield* Effect.promise(() => res.text())).toBe("success");

      res = yield* fetch("/");
      expect(res.status).toBe(429);
      expect(yield* Effect.promise(() => res.text())).toBe("rate limited");
    }),
  );

  it.effect("validates options passed to limit()", () =>
    Effect.gen(function* () {
      const { fetch } = yield* startTestWorker({
        name: "ratelimit-validation",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: RATE_LIMIT_VALIDATION_SCRIPT }],
        bindings: [
          RateLimit.local({
            binding: "TESTRATE",
            namespaceId: 1,
            simple: { limit: 2, period: 60 },
          }),
        ],
      });

      const TESTS = [
        { options: "invalid", error: "Error: invalid rate limit options" },
        { options: { invalid: "foo" }, error: "Error: bad rate limit options: [invalid]" },
        { options: { limit: "bad" }, error: "Error: limit must be a number: bad" },
        { options: { period: "bad" }, error: "Error: period must be a number: bad" },
        { options: { period: 1 }, error: "Error: unsupported period: 1" },
      ];

      for (const { options, error } of TESTS) {
        const res = yield* fetch("/", {
          method: "POST",
          body: JSON.stringify(options),
        });
        expect(res.status).toBe(200);
        expect(yield* Effect.promise(() => res.text())).toBe(error);
      }
    }),
  );
});
