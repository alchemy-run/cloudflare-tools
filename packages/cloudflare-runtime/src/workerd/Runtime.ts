import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { Config } from "./Config.ts";
import { RuntimeError } from "./RuntimeError.ts";
import { serializeConfig } from "./internal/config.serialize.ts";
import * as Workerd from "./internal/workerd.ts";

export type ControlMessage =
  | {
      event: "listen";
      socket: string;
      port: number;
    }
  | {
      event: "listen-inspector";
      port: number;
    };

export class Runtime extends Context.Service<
  Runtime,
  {
    readonly compatibilityDate: string;
    readonly serve: (
      config: Config,
      args?: Record<string, string | number | boolean>,
    ) => Effect.Effect<Array<ControlMessage>, RuntimeError, Scope.Scope>;
  }
>()("cloudflare-runtime/workerd/Runtime") {}

export const layer = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const spawn = (config: Config, args?: Record<string, string | number | boolean>) =>
      ChildProcess.make(
        Workerd.bin,
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
        {
          stdin: Stream.succeed(new Uint8Array(serializeConfig(config))),
          stdout: "inherit",
          stderr: "pipe",
          additionalFds: { fd3: { type: "output" } },
        },
      ).pipe(spawner.spawn, mapToRuntimeError("Failed to spawn workerd"));

    return Runtime.of({
      compatibilityDate: Workerd.compatibilityDate,
      serve: Effect.fn("Runtime.serve")(function* (config, args) {
        const handle = yield* Effect.acquireRelease(spawn(config, args), (handle) =>
          Effect.ignore(handle.kill({ killSignal: "SIGKILL" })),
        );

        const count =
          (config.sockets?.length ?? 0) +
          (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
          (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);
        const controlMessages = yield* readControlMessages(handle.getOutputFd(3), count);
        if (controlMessages.length !== count) {
          return yield* failureFromStderr(handle.stderr);
        }
        yield* handle.stderr.pipe(
          Stream.decodeText,
          Stream.runForEach(Effect.logError),
          Effect.forkChild,
        );
        return controlMessages;
      }),
    });
  }),
);

const readControlMessages = (stream: Stream.Stream<Uint8Array, PlatformError>, count: number) =>
  stream.pipe(
    Stream.decodeText,
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
                .map((line) => JSON.parse(line)),
            ),
          ),
      ),
    ),
    Effect.mapError(
      (error) => new RuntimeError({ message: "Failed to read control messages", cause: error }),
    ),
  );

const failureFromStderr = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText,
    Stream.tap(Effect.logError),
    Stream.runFold(
      () => "",
      (acc, data) => acc + data,
    ),
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((stderr) =>
      Effect.fail(
        new RuntimeError({
          message: "The Workers runtime failed to start.",
          stderr: stderr?.trim(),
        }),
      ),
    ),
  );

const mapToRuntimeError = (message: string) =>
  Effect.mapError(
    (error: unknown) =>
      new RuntimeError({
        message,
        cause: error,
      }),
  );
