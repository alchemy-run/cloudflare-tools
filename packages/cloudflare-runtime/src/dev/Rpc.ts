import { newWebSocketRpcSession, type RpcCompatible } from "capnweb";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const toSerialized = <Args extends Array<any>, Success, Error>(
  fn: RpcFunction<Args, Success, Error>,
  schema: { success: Schema.Encoder<Success>; error: Schema.Encoder<Error> },
): SerializedRpcFunction<Args, Success, Error> => {
  return (...args: Args) => {
    return fn(...args).pipe(
      Effect.exit,
      Effect.map(
        (exit): SerializedExit<Success, Error> =>
          exit._tag === "Success"
            ? { _tag: "Success", value: Schema.encodeSync(schema.success)(exit.value) }
            : { _tag: "Failure", cause: Schema.encodeSync(schema.error)(exit.cause) },
      ),
      Effect.runPromise,
    );
  };
};

export const toDeserialized = <Args extends Array<any>, Success, Error>(
  fn: SerializedRpcFunction<Args, Success, Error>,
  schema: { success: Schema.Decoder<Success>; error: Schema.Decoder<Error> },
): RpcFunction<Args, Success, Error> => {
  return (...args: Args) =>
    Effect.promise(() => fn(...args)).pipe(
      Effect.flatMap((exit) =>
        exit._tag === "Success"
          ? Effect.succeed(Schema.decodeSync(schema.success)(exit.value))
          : Effect.fail(Schema.decodeSync(schema.error)(exit.cause)),
      ),
    );
};

type RpcFunction<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Effect.Effect<Success, Error>;
type SerializedRpcFunction<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Promise<SerializedExit<Success, Error>>;

type AnyRpcTarget = Record<string, RpcFunction<any, any, any>>;

export type from<T extends AnyRpcTarget> = {
  [K in keyof T]: T[K] extends RpcFunction<infer Args, infer Success, infer Error>
    ? SerializedRpcFunction<Args, Success, Error>
    : never;
} extends infer O extends RpcCompatible<any>
  ? O
  : never;

export type RpcSchema<T extends AnyRpcTarget> = {
  [K in keyof T]: T[K] extends RpcFunction<any, infer Success, infer Error>
    ? { success: Schema.Codec<Success, any>; error: Schema.Codec<Error, any> }
    : never;
};

type SerializedExit<Success, Error> =
  | { _tag: "Success"; value: Success }
  | { _tag: "Failure"; cause: Error };

export class ClientError extends Data.TaggedError("ClientError")<{
  message: string;
  cause?: unknown;
}> {}

export const client = <T extends AnyRpcTarget>(url: string, schema: RpcSchema<T>) => {
  return Effect.gen(function* () {
    const ws = yield* connect(url);
    const session = yield* Effect.sync(() => newWebSocketRpcSession<from<T>>(ws));
    return Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        (...args: Array<any>) => {
          console.log("call", key, args);
          return toDeserialized(session[key as never], value)(...args);
        },
      ]),
    ) as T;
  });
};

const connect = (url: string) =>
  Effect.try({
    try: () => new URL(url),
    catch: (error) => new ClientError({ message: "Invalid URL", cause: error }),
  }).pipe(
    Effect.flatMap((url) =>
      Effect.callback<WebSocket, ClientError>((resume) => {
        const ws = new WebSocket(url);
        ws.addEventListener("open", () => {
          resume(Effect.succeed(ws));
        });
        ws.addEventListener("error", (event) => {
          resume(
            Effect.fail(
              new ClientError({ message: "Failed to connect to WebSocket", cause: event }),
            ),
          );
        });
        ws.addEventListener("close", () => {
          resume(Effect.fail(new ClientError({ message: "WebSocket closed", cause: undefined })));
        });
        return Effect.sync(() => ws.close());
      }),
    ),
  );

export const server = <T extends AnyRpcTarget>(target: T, schema: RpcSchema<T>) => {
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      toSerialized(target[key as keyof T], value),
    ]),
  ) as from<T>;
};
