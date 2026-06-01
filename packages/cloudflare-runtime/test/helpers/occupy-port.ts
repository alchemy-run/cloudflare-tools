import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

export const occupyPort = (port: number, host?: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", (err) => resume(Effect.die(err)));
      server.listen(port, host, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map((server) => server.address() as NodeNet.AddressInfo));
