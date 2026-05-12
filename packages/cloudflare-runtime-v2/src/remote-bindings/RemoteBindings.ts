import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ClientWorker from "worker:./workers/client.worker.ts";
import * as OutboundWorker from "worker:./workers/outbound.worker.ts";
import { makeErrorEnvelope } from "../internal/response.shared.ts";
import * as Plugin from "../Plugin.ts";
import * as PluginContext from "../PluginContext.ts";
import type { ApiError, ConfigError, SystemError } from "../RuntimeError.shared.ts";
import { moduleToWorkerd } from "../RuntimeWorker.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as Access from "./Access.ts";
import * as RemoteWorker from "./RemoteWorker.ts";
import type {
  RemoteBinding,
  RemoteWorkerConfig,
  RemoteWorkerResult,
} from "./RemoteWorkerConfig.shared.ts";

export class RemoteBindings extends Plugin.Service<
  RemoteBindings,
  {
    register: (binding: RemoteBinding) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/RemoteBindings") {}

export type { RemoteBinding };

export const RemoteBindingsLive = Layer.effect(
  RemoteBindings,
  Effect.gen(function* () {
    const httpServer = yield* HttpServer.HttpServer;
    const remoteWorker = yield* RemoteWorker.RemoteWorker;
    const prefetches = new Map<
      number,
      Fiber.Fiber<RemoteWorkerResult, ApiError | ConfigError | SystemError>
    >();
    yield* httpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const json = (yield* request.json) as unknown as RemoteWorkerConfig;
        const hash = Hash.structure(json);
        const prefetched = prefetches.get(hash);
        if (prefetched) {
          prefetches.delete(hash);
        }
        const deploy = prefetched ? Fiber.join(prefetched) : remoteWorker.deploy(json);
        return yield* deploy.pipe(
          Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
          Effect.catchIf(
            (e) => e._tag === "ApiError" || e._tag === "ConfigError" || e._tag === "SystemError",
            (error) => HttpServerResponse.json(makeErrorEnvelope(error), { status: 500 }),
          ),
        );
      }),
    );
    const address = httpServer.address as HttpServer.TcpAddress;
    const build = Effect.fn(function* (
      config: RemoteWorkerConfig,
    ): Effect.fn.Return<Plugin.PluginConfig> {
      if (config.bindings.length === 0) return {};
      const fiber = yield* Effect.forkDetach(remoteWorker.deploy(config));
      prefetches.set(Hash.structure(config), fiber);
      const loopback = {
        name: "remote-bindings:loopback",
        external: {
          address: `${address.hostname}:${address.port}`,
          http: {},
        },
      } satisfies WorkerdConfig.Service;
      const outbound = {
        name: "remote-bindings:outbound",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: OutboundWorker.modules.map(moduleToWorkerd),
          bindings: [
            {
              name: "PROXY",
              durableObjectNamespace: { className: "RemoteBindingProxy" },
            },
            {
              name: "LOOPBACK",
              service: { name: loopback.name },
            },
            {
              name: "OPTIONS",
              json: JSON.stringify(config),
            },
          ],
          durableObjectNamespaces: [
            {
              className: "RemoteBindingProxy",
              enableSql: true,
              preventEviction: true,
              ephemeralLocal: WorkerdConfig.kVoid,
            },
          ],
        },
      } satisfies WorkerdConfig.Service;
      const client = {
        name: "remote-bindings:client",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: ClientWorker.modules.map(moduleToWorkerd),
          globalOutbound: { name: outbound.name },
        },
      } satisfies WorkerdConfig.Service;
      return {
        services: [client, outbound, loopback],
      };
    });
    return RemoteBindings.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext.PluginContext;
        const bindings: Array<RemoteBinding> = [];
        const config: RemoteWorkerConfig = {
          name: worker.name,
          bindings,
        };
        return {
          defer: Effect.suspend(() => build(config)),
          api: {
            register: (binding) =>
              Effect.sync(() => {
                bindings.push(binding);
                return {
                  name: "remote-bindings:client",
                  props: {
                    json: JSON.stringify({ binding: binding.name }),
                  },
                };
              }),
          },
        };
      }),
    );
  }),
);

export const layerServices = (accountId: string) =>
  RemoteBindingsLive.pipe(
    Layer.provide(Layer.provide(RemoteWorker.layer(accountId), Access.layer)),
  );

export const makeRemoteBinding = (
  binding: RemoteBinding,
  f: (service: WorkerdConfig.ServiceDesignator) => WorkerdConfig.Worker_Binding,
): PluginContext.BindingHook<RemoteBindings> =>
  Effect.map(
    Plugin.use(RemoteBindings, (remoteBindings) => remoteBindings.api.register(binding)),
    f,
  );
