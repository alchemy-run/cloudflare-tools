import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import { flow, identity } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Server from "../server/Server.ts";
import { DevServer } from "./DevServer.ts";

const serialize =
  <A extends Schema.Encoder<any>, E extends Schema.Encoder<any>>(
    schema: Schema.Exit<A, E, Schema.Defect>,
  ) =>
  (effect: Effect.Effect<A["Type"], E["Type"]>) =>
    effect.pipe(Effect.exit, Effect.flatMap(Schema.encodeEffect(schema)), Effect.runPromise);

const deserialize =
  <A extends Schema.Decoder<any>, E extends Schema.Decoder<any>>(
    schema: Schema.Exit<A, E, Schema.Defect>,
  ) =>
  (promise: Promise<Exit.Exit<A["Encoded"], E["Encoded"]>>) =>
    Effect.promise(() => promise).pipe(
      Effect.flatMap(Schema.decodeEffect(schema)),
      Effect.catchTag("SchemaError", (e) => Effect.die(e)),
      Effect.flatMap(identity),
    );

type RpcTargetSchema = {
  [key: string]: Schema.Exit<any, any, Schema.Defect>;
};

type UnwrapSchemaExit<T extends Schema.Exit<any, any, Schema.Defect>> =
  T extends Schema.Exit<infer A, infer E, Schema.Defect>
    ? Effect.Effect<A["Type"], E["Type"]>
    : never;

type RpcTarget<T extends RpcTargetSchema> = {
  [K in keyof T]: (...args: Array<any>) => UnwrapSchemaExit<T[K]>;
};

type SerializedRpcTarget<S extends RpcTargetSchema, T extends RpcTarget<S>> = {
  [K in keyof T]: (
    ...args: Parameters<T[K]>
  ) => ReturnType<T[K]> extends Effect.Effect<infer Success, infer Error>
    ? Promise<Exit.Exit<Success, Error>>
    : never;
};

const makeTarget =
  <S extends RpcTargetSchema>(schema: S) =>
  <T extends RpcTarget<S>>(target: T) => {
    const main = {} as SerializedRpcTarget<S, T>;
    for (const [key, value] of Object.entries(target)) {
      main[key as keyof T] = flow(value, serialize(schema[key as keyof S])) as any;
    }
    return main;
  };

const makeClient =
  <S extends RpcTargetSchema>(schema: S) =>
  <T extends RpcTarget<S>>(target: SerializedRpcTarget<S, T>) => {
    const main = {} as T;
    for (const [key, value] of Object.entries(target)) {
      main[key as keyof T] = flow(value, deserialize(schema[key as keyof S])) as any;
    }
    return main;
  };

const RpcSchema = {
  serve: Schema.Exit(Server.ServeResult, Server.ServeError, Schema.DefectWithStack),
  stop: Schema.Exit(Schema.Void, Server.ServeError, Schema.DefectWithStack),
};

const targetFactory = makeTarget(RpcSchema);
const clientFactory = makeClient(RpcSchema);

export const rpc = Effect.gen(function* () {
  const server = yield* DevServer;
  const target = targetFactory(server);
  const client = clientFactory(target);
  return client;
});
