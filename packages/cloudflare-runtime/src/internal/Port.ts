import * as Effect from "effect/Effect";
import * as Net from "node:net";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";

export const MAX_PORT = 65535;

const HOSTS: Set<string> = new Set([
  "0.0.0.0",
  "::",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "localhost",
  "127.0.0.1",
  "::1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
]);

export const find = /* @__PURE__ */ Effect.fn(function* (port: number) {
  if (port === 0) {
    return yield* bind(port);
  }
  const start = port;
  while (port <= MAX_PORT) {
    const available = yield* check(port).pipe(Effect.orElseSucceed(() => false));
    if (available) {
      return port;
    }
    yield* Effect.logDebug(`Port ${port} is not available, trying ${port + 1}...`);
    port++;
  }
  return yield* new SystemError({
    subtag: "PortExhausted",
    message: `No available port found starting from ${start}.`,
    hint: "Free up a port in this range or pick a different starting port.",
    detail: { start },
  });
});

export const check = (port: number) =>
  Effect.forEach(HOSTS, (host) => bind(port, host)).pipe(Effect.as(port));

const bind = (port: number, host: string = "localhost") =>
  Effect.callback<number, ConfigError>((resume) => {
    const server = Net.createServer();
    server.once("error", () => {
      server.close(() =>
        resume(
          Effect.fail(
            new ConfigError({
              subtag: "AddressInUse",
              message: `Could not bind to port ${host}:${port} (already in use).`,
              hint: "Pick a different port or stop the process using it.",
              detail: { address: `${host}:${port}` },
            }),
          ),
        ),
      );
    });
    server.listen({ port, host, exclusive: true }, () => {
      const { port } = server.address() as Net.AddressInfo;
      server.close(() => resume(Effect.succeed(port)));
    });
    return Effect.sync(() => server.close());
  });
