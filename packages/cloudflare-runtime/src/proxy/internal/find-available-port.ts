import * as Effect from "effect/Effect";
import * as Net from "node:net";

const MAX_PORT = 65535;

export const findAvailablePort = /* @__PURE__ */ Effect.fn(function* (port: number, host?: string) {
  while (port <= MAX_PORT) {
    if (yield* isPortAvailable(port, host)) {
      return port;
    }
    yield* Effect.log(`Port ${port} is not available, trying ${port + 1}...`);
    port++;
  }
  return yield* Effect.die(new Error(`Port ${port} is not available`));
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
