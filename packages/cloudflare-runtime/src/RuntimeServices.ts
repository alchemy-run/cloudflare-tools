import type * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as Layer from "effect/Layer";
import { Assets, Hyperdrive } from "./bindings/index.ts";
import * as Globals from "./globals/Globals.ts";
import * as Internet from "./globals/Internet.ts";
import * as Loopback from "./globals/Loopback.ts";
import * as LoopbackServer from "./globals/LoopbackServer.ts";
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
    Layer.provide(credentials),
    Layer.provide(Access.layer),
  );

export const layerStorage = (config: StorageConfig | undefined) =>
  config ? Storage.layerDisk(config.directory) : Storage.layerTemp();

export const layerLoopback = () =>
  Layer.provide(Loopback.LoopbackLive, LoopbackServer.LoopbackServerLive);

export const layerLocalBindings = () =>
  Layer.mergeAll(Assets.AssetsLive, Hyperdrive.HyperdriveLive);

export const layerRuntime = (config: RuntimeConfig) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(layerLocalBindings()),
    Layer.provideMerge(layerRemoteBindings(config.api)),
    Layer.provide(LocalProxy.layerLive(config.server)),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(layerLoopback()),
    Layer.provide(layerStorage(config.storage)),
    Layer.provide(Internet.InternetLive),
    Layer.provide(Workerd.WorkerdLive),
  );
