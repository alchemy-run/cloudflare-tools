import * as Effect from "effect/Effect";
import * as ServerRpc from "../src/rpc-server.ts";
import { layers, run } from "./layers.ts";

await run(
  ServerRpc.serve({ rpcPort: 9000, port: 1337, storage: ".cache/local" }).pipe(
    Effect.provide(layers),
  ),
);
