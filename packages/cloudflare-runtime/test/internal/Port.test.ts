import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Port from "../../src/internal/Port.ts";
import { occupyPort } from "../helpers/occupy-port.ts";

describe("Port.find", () => {
  it.effect("returns a free port when the requested port is 0", () =>
    Effect.gen(function* () {
      const port = yield* Port.find(0);
      expect(port).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("returns the requested port when free", () =>
    Effect.gen(function* () {
      const selected = yield* Port.find(0);
      const port = yield* Port.find(selected);
      expect(port).toBe(selected);
    }),
  );

  it.effect("skips a port in use and returns the next available one", () =>
    Effect.gen(function* () {
      const occupied = yield* occupyPort(0);
      const next = yield* Port.find(occupied.port);
      expect(next).toBeGreaterThan(occupied.port);
    }),
  );
});
