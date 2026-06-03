import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";

export const MAX_PORT = 65535;

export interface Ports {
  /**
   * Finds an available port starting from the given one.
   */
  readonly find: (port: number) => Effect.Effect<number>;
  /**
   * Checks if a port is available and reserves it if it is; returns an error otherwise.
   */
  readonly check: (port: number) => Effect.Effect<number, ConfigError>;
  /**
   * Marks a port as occupied for the lifetime of the cache, preventing it from being assigned to another worker.
   * Note that this is best-effort; the caller should include retry logic to handle race conditions.
   */
  readonly reserve: (port: number) => Effect.Effect<void>;
}

const HOSTS: Set<string> = new Set([
  "0.0.0.0",
  "::",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "localhost",
  "127.0.0.1",
  "::1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
]);

interface PortsOptions {
  /** Prevents redundant lookups and helps with race conditions; should only be disabled for testing. */
  readonly cache: boolean;
}

export const make = (options: PortsOptions) =>
  Effect.gen(function* () {
    const addressInUseError = (port: number) =>
      new ConfigError({
        subtag: "AddressInUse",
        message: `Could not bind to port ${port} (already in use).`,
        hint: "Pick a different port or stop the process using it.",
        detail: { address: `localhost:${port}` },
      });
    const bind = (port: number, host?: string) =>
      Effect.callback<number, ConfigError>((resume) => {
        const server = NodeNet.createServer();
        server.once("error", () => {
          server.close(() => resume(Effect.fail(addressInUseError(port))));
        });
        server.listen({ port, host, exclusive: true }, () => {
          const { port } = server.address() as NodeNet.AddressInfo;
          server.close(() => resume(Effect.succeed(port)));
        });
        return Effect.sync(() => server.close());
      });
    const cache = yield* Cache.makeWith(
      (port: number) =>
        Effect.forEach(HOSTS, (host) => bind(port, host)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      {
        capacity: options.cache ? Infinity : 0,
        // Cache for 30 seconds if the port is *not* available to prevent redundant lookups.
        // If a port *is* available, we don't cache it since it will likely be claimed shortly after lookup.
        timeToLive: (exit) => (exit._tag === "Success" && exit.value ? 0 : "30 seconds"),
      },
    );
    const reserve = (port: number) => Cache.set(cache, port, false);
    return {
      find: Effect.fn(function* (port) {
        if (port === 0) {
          return yield* bind(port).pipe(Effect.tap(reserve));
        }
        const start = port;
        while (port <= MAX_PORT) {
          const available = yield* Cache.get(cache, port);
          if (available) {
            yield* reserve(port);
            return port;
          }
          yield* Effect.logDebug(`Port ${port} is not available, trying ${port + 1}...`);
          port++;
        }
        // This should essentially never happen, so it's a `die` rather than a `fail`.
        return yield* Effect.die(
          new SystemError({
            subtag: "PortExhausted",
            message: `No available port found starting from ${start}.`,
            hint: "Free up a port in this range or pick a different starting port.",
            detail: { start },
          }),
        );
      }),
      check: (port) =>
        Cache.get(cache, port).pipe(
          Effect.flatMap((available) =>
            available ? reserve(port).pipe(Effect.as(port)) : Effect.fail(addressInUseError(port)),
          ),
        ),
      reserve,
    } as Ports;
  });
