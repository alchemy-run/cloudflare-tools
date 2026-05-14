import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { exitHook } from "../internal/exit-hook.ts";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";
import type { Config } from "./Config.ts";
import { serializeConfig } from "./internal/config.serialize.ts";
import * as workerd from "./internal/workerd.ts";

type ControlMessage =
  | {
      event: "listen";
      socket: string;
      port: number;
    }
  | {
      event: "listen-inspector";
      port: number;
    };

export interface WorkerdPorts {
  [socket: string]: number;
}

export class Workerd extends Context.Service<
  Workerd,
  {
    readonly compatibilityDate: string;
    readonly serve: (
      config: Config,
      args?: Record<string, string | number | boolean>,
    ) => Effect.Effect<WorkerdPorts, ConfigError | SystemError, Scope.Scope>;
  }
>()("cloudflare-runtime/workerd/Workerd") {}

export const WorkerdLive = Layer.effect(
  Workerd,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const spawn = (config: Config, args?: Record<string, string | number | boolean>) =>
      ChildProcess.make(
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
        {
          stdin: Stream.succeed(new Uint8Array(serializeConfig(config))),
          stdout: "inherit",
          stderr: "pipe",
          additionalFds: { fd3: { type: "output" } },
          detached: false,
        },
      ).pipe(
        spawner.spawn,
        Effect.mapError(
          (error) =>
            new SystemError({
              subtag: "WorkerdSpawn",
              message: "Failed to spawn the Workers runtime (workerd) process.",
              hint: "Make sure the workerd binary is available for this platform.",
              cause: error,
            }),
        ),
      );

    return Workerd.of({
      compatibilityDate: workerd.compatibilityDate,
      serve: Effect.fn("Workerd.serve")(function* (config, args) {
        const handle = yield* spawn(config, args);

        // Effect finalizers may not run reliably when the process is interrupted.
        // As a workaround, we use a synchronous exit hook to kill the process as a last resort.
        const unregister = exitHook(() => {
          try {
            process.kill(handle.pid, "SIGKILL");
          } catch {}
        });

        yield* Effect.addFinalizer(() =>
          handle.kill({ killSignal: "SIGKILL" }).pipe(
            Effect.tap(() => Effect.sync(unregister)),
            Effect.ignore,
          ),
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
        const ports: WorkerdPorts = {};
        for (const message of controlMessages) {
          if (message.event === "listen") {
            ports[message.socket] = message.port;
          }
        }
        return ports;
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
      (error) =>
        new SystemError({
          subtag: "WorkerdIpc",
          message: "Failed to read control messages from the Workers runtime.",
          cause: error,
        }),
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
    // If reading stderr itself fails, log a debug breadcrumb and fall back
    // to the same generic "failed to start" path so callers always see a
    // structured tagged error.
    Effect.tapCause((cause) => Effect.logDebug(cause)),
    Effect.orElseSucceed(() => undefined),
    Effect.flatMap((stderr) => Effect.fail(classifyWorkerdStderr(stderr))),
  );

/**
 * Workerd writes failures to stderr in a few well-known shapes. This
 * classifier inspects the captured stderr and decides whether the failure
 * is a user-facing config error (bad worker script or config) or a
 * lower-level system error (port conflict, internal workerd error, etc.).
 */
const classifyWorkerdStderr = (stderr: string | undefined): ConfigError | SystemError => {
  const text = (stderr ?? "").trim();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Pattern: `service <name>: <message>` is workerd's way of reporting a
  // problem with one of the user's services (script load failure, missing
  // compatibility date, syntax error in user script, etc.).
  const serviceLine = lines.find((line) => /^service [^:]+:/.test(line));
  if (serviceLine) {
    const match = serviceLine.match(/^service ([^:]+): (.*)$/);
    const [, service, detail] = match ?? [];
    return new ConfigError({
      subtag: "WorkerdUserScript",
      message: detail ?? serviceLine,
      hint: service ? `Check the configuration for service "${service}".` : undefined,
      detail: { stderr: text, service },
    });
  }

  // Pattern: address-in-use comes through as a `kj::Exception`.
  if (/Address already in use/i.test(text)) {
    return new SystemError({
      subtag: "WorkerdAddressInUse",
      message: "The Workers runtime could not bind to the requested address (already in use).",
      hint: "Pick a different port or stop the process using it.",
      detail: { stderr: text },
    });
  }

  return new SystemError({
    subtag: "WorkerdStartFailed",
    message: "The Workers runtime failed to start.",
    detail: { stderr: text },
  });
};
