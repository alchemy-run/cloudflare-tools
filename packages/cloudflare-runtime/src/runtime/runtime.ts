import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { serializeConfig } from "./config.serialize.ts";
import type { Config } from "./config.types.ts";

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("RuntimeError", {
  message: Schema.String,
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {}

export const ControlMessage = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("listen"),
    socket: Schema.String,
    port: Schema.Number,
  }),
  Schema.Struct({
    event: Schema.Literal("listen-inspector"),
    port: Schema.Number,
  }),
]);
export type ControlMessage = typeof ControlMessage.Type;

export class Runtime extends Context.Service<
  Runtime,
  {
    readonly compatibilityDate: string;
    readonly serve: (
      config: Config,
      args?: Record<string, string | number | boolean>,
    ) => Effect.Effect<Array<ControlMessage>, RuntimeError, Scope.Scope>;
  }
>()("Runtime") {}

export interface ProcessHandle {
  readonly kill: (options?: {
    killSignal?: ChildProcess.Signal;
  }) => Effect.Effect<void, PlatformError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError>;
  readonly control: Stream.Stream<Uint8Array, PlatformError>;
}

export const make = Effect.fnUntraced(function* (
  handler: (
    bin: string,
    args: Array<string>,
    stdin: Stream.Stream<Uint8Array>,
  ) => Effect.Effect<ProcessHandle, PlatformError, Scope.Scope>,
) {
  const workerd = yield* Workerd;
  return Runtime.of({
    compatibilityDate: workerd.compatibilityDate,
    serve: Effect.fn("Runtime.serve")((config, args) =>
      Effect.gen(function* () {
        const process = yield* handler(
          workerd.bin,
          [
            "serve",
            "--binary",
            "--experimental",
            "--verbose",
            "--control-fd=3",
            ...Object.entries(args ?? {}).map(([key, value]) =>
              typeof value === "boolean" ? `--${key}` : `--${key}=${value}`,
            ),
            "-",
          ],
          Stream.succeed(new Uint8Array(serializeConfig(config))),
        ).pipe(
          Effect.mapError((error) => {
            console.error("Error starting workerd", error);
            return new RuntimeError({
              message: "The workerd process failed to start",
              cause: error,
            });
          }),
        );
        yield* Effect.addFinalizer(() => Effect.ignore(process.kill({ killSignal: "SIGKILL" })));
        yield* Effect.forkChild(
          process.stderr.pipe(Stream.runForEach((log) => Effect.logError(log.toString()))),
        );
        const count =
          (config.sockets?.length ?? 0) +
          (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
          (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);
        const controlMessages = yield* readControlMessages(process.control, count);
        if (controlMessages.length !== count) {
          const stderr = yield* readStderr(process.stderr);
          return yield* new RuntimeError({
            message: "The workerd process failed to start",
            stderr,
          });
        }
        console.log("Control messages", controlMessages);
        return controlMessages;
      }),
    ),
  });
});

export const RuntimeLive = Layer.effect(
  Runtime,
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
    make((bin, args, stdin) =>
      spawner
        .spawn(
          ChildProcess.make(bin, args, {
            stdin,
            stdout: "inherit",
            stderr: "pipe",
            additionalFds: { fd3: { type: "output" } },
          }),
        )
        .pipe(
          Effect.map((process) => ({
            kill: process.kill,
            stderr: process.stderr,
            control: process.getOutputFd(3),
          })),
        ),
    ),
  ),
);

export interface Workerd {
  bin: string;
  compatibilityDate: string;
  version: string;
}

export const Workerd = Effect.promise(async (): Promise<Workerd> => {
  const pkg = await import("workerd");
  const bin =
    typeof pkg.default === "string"
      ? (pkg.default as string)
      : (pkg.default as { default: string }).default;
  return {
    bin,
    compatibilityDate: pkg.compatibilityDate,
    version: pkg.version,
  };
});

export const readStderr = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.run(
      Sink.fold(
        () => "",
        () => true,
        (acc, data) => Effect.succeed(acc + data),
      ),
    ),
    Effect.mapError(
      (error) =>
        new RuntimeError({
          message: "Failed to read stderr",
          cause: error,
        }),
    ),
  );

export const readControlMessages = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
  count: number,
) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.run(
      Sink.fold(
        () => [] as Array<ControlMessage>,
        (acc) => acc.length < count,
        (acc, data) =>
          Effect.succeed(
            acc.concat(
              data
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => Schema.decodeSync(ControlMessage)(JSON.parse(line))),
            ),
          ),
      ),
    ),
    Effect.mapError(
      (error) =>
        new RuntimeError({
          message: "Failed to read control messages",
          cause: error,
        }),
    ),
  );
