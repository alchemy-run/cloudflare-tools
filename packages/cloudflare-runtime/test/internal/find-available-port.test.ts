import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Net from "node:net";
import {
  allocatePort,
  findAvailablePort,
  isPortAvailable,
} from "../../src/internal/find-available-port.ts";

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

describe("isPortAvailable", () => {
  it.effect("reports a free port as available and an occupied one as not", () =>
    Effect.gen(function* () {
      const occupied = yield* occupy(0, "127.0.0.1");
      const occupiedPort = (occupied.address() as Net.AddressInfo).port;
      expect(yield* isPortAvailable(occupiedPort, "127.0.0.1")).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("allocatePort", () => {
  it.effect("returns a free, bindable ephemeral port", () =>
    Effect.gen(function* () {
      const port = yield* allocatePort("127.0.0.1");
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
      // allocatePort releases the socket before resolving, so the port it hands
      // back must be free for the caller (here, workerd) to bind.
      const server = yield* occupy(port, "127.0.0.1");
      expect((server.address() as Net.AddressInfo).port).toBe(port);
    }).pipe(Effect.scoped),
  );

  it.effect("hands out distinct ports to concurrent allocations", () =>
    Effect.gen(function* () {
      // Each allocation holds its socket open until the OS has assigned a port,
      // so concurrent callers can never be handed the same one.
      const ports = yield* Effect.all(
        Array.from({ length: 10 }, () => allocatePort("127.0.0.1")),
        { concurrency: "unbounded" },
      );
      expect(new Set(ports).size).toBe(ports.length);
    }),
  );
});
