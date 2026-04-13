import { kVoid, type Service } from "#/runtime/config.types";
import * as Bundle from "#/utils/bundle";
import * as Effect from "effect/Effect";

export const Services = Effect.fn(function* (configPort: number) {
  const config = {
    name: "remote-bindings:config",
    external: {
      address: `localhost:${configPort}`,
      http: {},
    },
  } satisfies Service;
  const outbound = {
    name: "remote-bindings:outbound",
    worker: {
      compatibilityDate: "2026-03-10",
      modules: yield* Bundle.bundle("src/bindings/workers/outbound.worker.ts").pipe(
        Effect.flatMap(Bundle.bundleOutputToWorkerd),
      ),
      bindings: [
        {
          name: "PROXY",
          durableObjectNamespace: { className: "RemoteBindingProxy" },
        },
        {
          name: "LOOPBACK",
          service: { name: config.name },
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
      modules: yield* Bundle.bundle("src/bindings/workers/client.worker.ts").pipe(
        Effect.flatMap(Bundle.bundleOutputToWorkerd),
      ),
      globalOutbound: { name: outbound.name },
    },
  } satisfies Service;
  return [client, outbound, config];
});
