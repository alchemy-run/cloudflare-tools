import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { cachedFunction } from "../../src/internal/cached-function.ts";

describe("cachedFunction", () => {
  it.effect("returns the same result on repeated calls", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const fn = yield* cachedFunction((arg: { id: string }) =>
        Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map((n) => `${arg.id}:${n}`)),
      );
      const a1 = yield* fn({ id: "a" });
      const a2 = yield* fn({ id: "a" });
      const b1 = yield* fn({ id: "b" });
      expect(a1).toBe("a:1");
      expect(a2).toBe("a:1");
      expect(b1).toBe("b:2");
    }),
  );

  it.live("deduplicates concurrent calls with the same key", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const fn = yield* cachedFunction((_: { id: string }) =>
        Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.delay("10 millis")),
      );
      const [a, b, c] = yield* Effect.all(
        [fn({ id: "x" }), fn({ id: "x" }), fn({ id: "x" })],
        { concurrency: "unbounded" },
      );
      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(c).toBe(1);
      expect(yield* Ref.get(counter)).toBe(1);
    }),
  );

  it.effect("does not cache failures", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const fn = yield* cachedFunction((_: { id: string }) =>
        Ref.updateAndGet(counter, (n) => n + 1).pipe(
          Effect.flatMap((n) => (n < 2 ? Effect.fail("nope") : Effect.succeed(n))),
        ),
      );
      const first = yield* fn({ id: "a" }).pipe(Effect.flip);
      expect(first).toBe("nope");
      const second = yield* fn({ id: "a" });
      expect(second).toBe(2);
    }),
  );

  it.effect("supports a custom key function", () =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const fn = yield* cachedFunction(
        (arg: { id: string; ignored: number }) =>
          Ref.updateAndGet(counter, (n) => n + 1).pipe(Effect.map((n) => `${arg.id}:${n}`)),
        { key: (arg) => arg.id },
      );
      const r1 = yield* fn({ id: "a", ignored: 1 });
      const r2 = yield* fn({ id: "a", ignored: 99 });
      expect(r1).toBe("a:1");
      expect(r2).toBe("a:1");
    }),
  );
});
