import { newWebSocketRpcSession } from "capnweb";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as net from "node:net";
import type { HyperdriveAdapter } from "./HyperdriveAdapter";

export class HyperdriveProxy extends Context.Service<
  HyperdriveProxy,
  {
    readonly make: (
      name: string,
      remoteOutboundUrlEffect: Effect.Effect<string>,
    ) => Effect.Effect<{ address: string }, never, Scope.Scope>;
  }
>()("cloudflare-runtime/hyperdrive/HyperdriveProxy") {}

export const layer = Layer.effect(
  HyperdriveProxy,
  Effect.gen(function* () {
    yield* Effect.logInfo("[hyperdrive-proxy] initializing");
    return HyperdriveProxy.of({
      make: Effect.fn(function* (name, remoteOutboundUrlEffect) {
        const createSession = remoteOutboundUrlEffect.pipe(
          Effect.map((urlString) => {
            const url = new URL(urlString);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            url.searchParams.set("MF-Binding", name);
            return newWebSocketRpcSession<HyperdriveAdapter>(url.href);
          }),
        );
        const server = net.createServer(async (socket) => {
          const session = await Effect.runPromise(createSession);
          const info = await session.hyperdrive.info();
          const { readable, writable, close } = await session.hyperdrive.connect();
        });
        yield* Effect.addFinalizer(() => {
          server.close();
          return Effect.void;
        });
        const port = yield* listen(server);
        return { address: `127.0.0.1:${port}` };
      }),
    });
  }),
);

const listen = (server: net.Server) =>
  Effect.callback<number>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      if (address && typeof address !== "string") {
        resume(Effect.succeed(address.port));
      } else {
        resume(Effect.die(new Error("Invalid port")));
      }
    });
  });
