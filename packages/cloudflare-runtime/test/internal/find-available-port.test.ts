import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Net from "node:net";
import { findAvailablePort } from "../../src/internal/find-available-port.ts";

const occupy = (port: number, host: string) =>
  Effect.acquireRelease(
    Effect.callback<Net.Server>((resume) => {
      const server = Net.createServer();
      server.once("error", (err) => resume(Effect.die(err)));
      server.listen(port, host, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

describe("findAvailablePort", () => {
  it.effect("returns the requested port when free", () =>
    Effect.gen(function* () {
      const port = yield* findAvailablePort(0, "127.0.0.1");
      expect(port).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("skips a port in use and returns the next available one", () =>
    Effect.gen(function* () {
      const occupied = yield* occupy(0, "127.0.0.1");
      const occupiedPort = (occupied.address() as Net.AddressInfo).port;
      const next = yield* findAvailablePort(occupiedPort, "127.0.0.1");
      expect(next).toBeGreaterThan(occupiedPort);
    }).pipe(Effect.scoped),
  );
});
