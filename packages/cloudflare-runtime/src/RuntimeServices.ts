import * as Layer from "effect/Layer";
import {
  Assets,
  DispatchNamespace,
  Hyperdrive,
  RateLimit,
  SendEmail,
  Workflows,
} from "./bindings/index.ts";
import * as DevRegistry from "./dev-registry/DevRegistry.ts";
import * as DevRegistryProxy from "./dev-registry/DevRegistryProxy.ts";
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
  api: ApiConfig;
  storage?: StorageConfig;
}

export interface ApiConfig {
  accountId: string;
}

export interface StorageConfig {
  directory: string;
}

export const layerRemoteBindings = ({ accountId }: ApiConfig) =>
  RemoteBindings.RemoteBindingsLive.pipe(
    Layer.provide(RemoteWorker.layer(accountId)),
    Layer.provide(Access.layer),
  );

export const layerStorage = (config: StorageConfig | undefined) =>
  config ? Storage.layerDisk(config.directory) : Storage.layerTemp();

export const layerLoopback = () =>
  Layer.provide(Loopback.LoopbackLive, LoopbackServer.LoopbackServerLive);

export const layerLocalBindings = () =>
  Layer.mergeAll(
    Assets.AssetsLive,
    DevRegistryProxy.DevRegistryProxyLive,
    DispatchNamespace.DispatchNamespaceLive,
    Hyperdrive.HyperdriveLive,
    RateLimit.RateLimitLive,
    SendEmail.SendEmailLive,
    Workflows.WorkflowsLive,
  );

export type BindingServices =
  | Assets.Assets
  | Loopback.Loopback
  | Hyperdrive.Hyperdrive
  | RemoteBindings.RemoteBindings
  | DevRegistryProxy.DevRegistryProxy
  | Workflows.Workflows;

export type RuntimeServices = Runtime.Runtime | BindingServices;

export const layerLocalProxy = (port?: number) =>
  Layer.provide(
    LocalProxy.LocalProxyLive(port),
    Layer.mergeAll(Internet.InternetLive, Workerd.WorkerdLive),
  );

export const layerRuntime = (config: RuntimeConfig) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(layerLocalBindings()),
    Layer.provideMerge(layerRemoteBindings(config.api)),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(layerLoopback()),
    Layer.provide(layerStorage(config.storage)),
    Layer.provide(Internet.InternetLive),
    Layer.provide(DevRegistry.DevRegistryLive),
    Layer.provide(Workerd.WorkerdLive),
  );
