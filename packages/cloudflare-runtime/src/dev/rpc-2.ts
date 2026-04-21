import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Server from "../server/Server.ts";
import { DevServer } from "./DevServer.ts";

export type RpcFunction<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Effect.Effect<Success, Error>;

export type RpcInterface = {
  [key: string]: RpcFunction<any, any, any>;
};

export type RpcResultSchema<T extends RpcFunction<any, any, any>> =
  T extends RpcFunction<any, infer Success, infer Error>
    ? Schema.Exit<Schema.Decoder<Success>, Schema.Decoder<Error>, Schema.Defect>
    : never;

export type RpcSchema<T extends RpcInterface> = {
  [K in keyof T]: RpcResultSchema<T[K]>;
};

const RpcSchema = {
  serve: Schema.Exit(Server.ServeResult, Server.ServeError, Schema.DefectWithStack),
  stop: Schema.Exit(Schema.Void, Server.ServeError, Schema.DefectWithStack),
};

declare function makeInterface<I extends RpcInterface>(
  value: I,
): <S extends RpcSchema<I>>(schema: S) => I;

const program = Effect.gen(function* () {
  const server = yield* DevServer;
  makeInterface(server)({
    serve: Schema.Exit(Server.ServeResult, Server.ServeError, Schema.DefectWithStack),
    stop: Schema.Exit(Schema.Void, Server.ServeError, Schema.DefectWithStack),
  });
});
