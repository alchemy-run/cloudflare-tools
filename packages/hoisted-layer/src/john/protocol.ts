// please ignore this sandbox file

import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export class LayerNotFound extends Schema.TaggedErrorClass<LayerNotFound>()("LayerNotFound", {
  message: Schema.String,
  layer: Schema.NonEmptyString,
}) {}

export class MethodNotFound extends Schema.TaggedErrorClass<MethodNotFound>()("MethodNotFound", {
  message: Schema.String,
  layer: Schema.NonEmptyString,
  method: Schema.NonEmptyString,
}) {}

const heartbeat = Rpc.make("heartbeat");

const validate = Rpc.make("validate", {
  payload: {
    layer: Schema.NonEmptyString,
  },
  error: LayerNotFound,
});

const call = Rpc.make("call", {
  payload: {
    layer: Schema.NonEmptyString,
    method: Schema.NonEmptyString,
    args: Schema.Array(Schema.Any),
  },
  success: Schema.Exit(Schema.Unknown, Schema.Unknown, Schema.Unknown),
  error: Schema.Union([LayerNotFound, MethodNotFound]),
});

export const group = RpcGroup.make(heartbeat, validate, call);
