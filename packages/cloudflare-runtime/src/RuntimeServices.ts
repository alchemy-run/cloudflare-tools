import type * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServer } from "effect/unstable/http/HttpServer";
import type { ServeError } from "effect/unstable/http/HttpServerError";
import { Assets, Hyperdrive } from "./bindings/index.ts";
import * as Globals from "./globals/Globals.ts";
import * as Internet from "./globals/Internet.ts";
import * as Storage from "./globals/Storage.ts";
import * as LocalProxy from "./proxy/LocalProxy.ts";
import { Access, RemoteBindings, RemoteWorker } from "./remote-bindings/index.ts";
import * as Runtime from "./Runtime.ts";
import * as Workerd from "./workerd/Workerd.ts";

export interface RuntimeConfig {
  server: HttpServerConfig;
  api: ApiConfig;
  storage?: StorageConfig;
}

export interface HttpServerConfig {
  port: number;
  host: string;
}

export interface ApiConfig {
  accountId: string;
  credentials: Layer.Layer<Credentials.Credentials>;
}

export interface StorageConfig {
  directory: string;
}

export const layerRemoteBindings = ({ accountId, credentials }: ApiConfig) =>
  RemoteBindings.RemoteBindingsLive.pipe(
    Layer.provide(RemoteWorker.layer(accountId)),
    Layer.provide(layerHttpServer({ port: 0, host: "127.0.0.1" })),
    Layer.provide(credentials),
    Layer.provide(Access.layer),
  );

export const layerHttpServer = ({
  port,
  host,
}: HttpServerConfig): Layer.Layer<HttpServer, ServeError> =>
  Effect.promise(async () => {
    if (typeof globalThis.Bun !== "undefined") {
      try {
        const BunHttpServer = await import("@effect/platform-bun/BunHttpServer");
        return BunHttpServer.layer({ hostname: host, port });
      } catch {}
    }
    const [NodeHttpServer, NodeHttp] = await Promise.all([
      import("@effect/platform-node/NodeHttpServer"),
      import("node:http"),
    ]);
    return NodeHttpServer.layerServer(NodeHttp.createServer, { host, port });
  }).pipe(Layer.unwrap);

export const layerStorage = (config: StorageConfig | undefined) =>
  config ? Storage.layerDisk(config.directory) : Storage.layerTemp();

export const layerLocalBindings = () =>
  Layer.mergeAll(Assets.AssetsLive, Hyperdrive.HyperdriveLive);

export const layerRuntime = (config: RuntimeConfig) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(layerLocalBindings()),
    Layer.provideMerge(layerRemoteBindings(config.api)),
    Layer.provide(LocalProxy.layerLive(config.server)),
    Layer.provide(Globals.GlobalsLive),
    Layer.provide(layerStorage(config.storage)),
    Layer.provide(Internet.InternetLive),
    Layer.provide(Workerd.WorkerdLive),
  );
