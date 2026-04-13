import { kVoid, type Service } from "#/runtime/config.types";
import { bundleAsEsModule } from "#/utils/bundle";
import * as Effect from "effect/Effect";
import { SessionProvider, type SessionOptions } from "./session";

export const WorkerLive = Effect.fn(function* (options: SessionOptions) {
  const session = yield* SessionProvider;
  const server = yield* Effect.acquireRelease(
    // TODO: effectify
    Effect.sync(() =>
      Bun.serve({
        fetch: async () => {
          const config = await Effect.runPromise(session.create(options));
          return Response.json(config);
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop()),
  );
  const loopback = {
    name: "remote-bindings:loopback",
    external: {
      address: `localhost:${server.port}`,
      http: {},
    },
  } satisfies Service;
  const outbound = {
    name: "remote-bindings:outbound",
    worker: {
      compatibilityDate: "2026-03-10",
      modules: [yield* bundleAsEsModule("src/bindings/workers/outbound.worker.ts")],
      bindings: [
        {
          name: "PROXY",
          durableObjectNamespace: { className: "RemoteBindingProxy" },
        },
        {
          name: "LOOPBACK",
          service: { name: loopback.name },
        },
      ],
      durableObjectNamespaces: [
        {
          className: "RemoteBindingProxy",
          enableSql: true,
          preventEviction: true,
          ephemeralLocal: kVoid,
        },
      ],
    },
  } satisfies Service;
  const client = {
    name: "remote-bindings:client",
    worker: {
      compatibilityDate: "2026-03-10",
      modules: [yield* bundleAsEsModule("src/bindings/workers/client.worker.ts")],
      globalOutbound: { name: outbound.name },
    },
  } satisfies Service;
  return {
    services: [client, outbound, loopback],
  };
});
