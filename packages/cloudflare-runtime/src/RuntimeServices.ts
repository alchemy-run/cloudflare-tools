import * as Layer from "effect/Layer";
import {
  AnalyticsEngine,
  Assets,
  DispatchNamespace,
  Hyperdrive,
  Queue,
  RateLimit,
  SendEmail,
  Workflows,
} from "./bindings/index.ts";
import { Globals, Internet, Loopback, LoopbackServer, Storage } from "./globals/index.ts";
import * as Paths from "./internal/Paths.ts";
import * as WorkerProxy from "./proxy/WorkerProxy.ts";
import { Registry, RegistryProxy } from "./registry/index.ts";
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
    AnalyticsEngine.AnalyticsEngineLive,
    Assets.AssetsLive,
    DispatchNamespace.DispatchNamespaceLive,
    Hyperdrive.HyperdriveLive,
    Queue.QueueLive,
    RateLimit.RateLimitLive,
    SendEmail.SendEmailLive,
    Workflows.WorkflowsLive,
  );

export type BindingServices =
  | AnalyticsEngine.AnalyticsEngine
  | Assets.Assets
  | DispatchNamespace.DispatchNamespace
  | Hyperdrive.Hyperdrive
  | Loopback.Loopback
  | Queue.Queue
  | RateLimit.RateLimit
  | RemoteBindings.RemoteBindings
  | RegistryProxy.RegistryProxy
  | SendEmail.SendEmail
  | Workflows.Workflows;

export type RuntimeServices = Runtime.Runtime | BindingServices;

export const layerProxy = () =>
  Layer.provide(
    WorkerProxy.WorkerProxyLive,
    Layer.mergeAll(Internet.InternetLive, Workerd.WorkerdLive),
  );

export const layerRegistry = () =>
  RegistryProxy.RegistryProxyLive.pipe(Layer.provide(Registry.RegistryLive));

export const layerRuntime = (config: RuntimeConfig) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(layerLocalBindings()),
    Layer.provideMerge(layerRemoteBindings(config.api)),
    Layer.provideMerge(WorkerProxy.WorkerProxyLive),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(layerLoopback()),
    Layer.provide(layerStorage(config.storage)),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(layerRegistry()),
    Layer.provide(Paths.PathsLive),
    Layer.provide(Workerd.WorkerdLive),
  );
