import * as Effect from "effect/Effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { group } from "./protocol.ts";

export const client = RpcClient.make(group, { flatten: true }).pipe(
  Effect.map((client) => {
    return {
      client,
    };
  }),
);
