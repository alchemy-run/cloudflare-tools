import * as Layer from "effect/Layer";
import * as Server from "./Server.ts";
import * as Storage from "./Storage.ts";
import * as Bindings from "./bindings/Bindings.ts";
import * as RemoteSession from "./bindings/RemoteSession.ts";
import * as LocalProxy from "./proxy/LocalProxy.ts";
import * as Runtime from "./workerd/Runtime.ts";

export const layer = (config: {
  host?: string;
  port?: number;
  storage?: string;
  accountId: string;
}) =>
  Server.layer.pipe(
    Layer.provideMerge(
      LocalProxy.layerLive({ host: config.host ?? "localhost", port: config.port ?? 1337 }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Runtime.layer,
        config.storage ? Storage.layerDisk(config.storage) : Storage.layerTemp(),
        Layer.provide(Bindings.layer, RemoteSession.layer(config.accountId)),
      ),
    ),
  );
