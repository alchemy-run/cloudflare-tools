import * as Effect from "effect/Effect";
import * as Net from "node:net";
import { SystemError } from "../RuntimeError.shared.ts";

export const MAX_PORT = 65535;

export const findAvailablePort = /* @__PURE__ */ Effect.fn(function* (port: number, host?: string) {
  const start = port;
  while (port <= MAX_PORT) {
    if (yield* isPortAvailable(port, host)) {
      return port;
    }
    yield* Effect.logDebug(`Port ${port} is not available, trying ${port + 1}...`);
    port++;
  }
  return yield* new SystemError({
    subtag: "PortExhausted",
    message: `No available port found starting from ${start}${host ? ` on ${host}` : ""}.`,
    hint: "Free up a port in this range or pick a different starting port.",
    detail: { start, host },
  });
});

const isPortAvailable = (port: number, host?: string) =>
  Effect.callback<boolean>((resume) => {
    const server = Net.createServer();
    server.once("error", (e: NodeJS.ErrnoException) => {
      server.close(() => resume(Effect.succeed(e.code !== "EADDRINUSE")));
    });
    server.once("listening", () => {
      server.close(() => resume(Effect.succeed(true)));
    });
    server.listen(port, host);
  });
