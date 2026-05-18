import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
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
    const spawner = yield* ChildProcessSpawner;

    return Workerd.of({
      compatibilityDate: workerd.compatibilityDate,
      serve: Effect.fn("Workerd.serve")(
        function* (config, args) {
          const count =
            (config.sockets?.length ?? 0) +
            (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
            (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);

          const command = ChildProcess.make(
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
              stdin: Stream.make(new Uint8Array(serializeConfig(config))),
              stdout: "inherit",
              stderr: "pipe",
              detached: false,
              additionalFds: {
                fd3: { type: "output" },
              },
              killSignal: "SIGKILL",
            },
          );

          const handle = yield* spawner.spawn(command).pipe(
            Effect.mapError(
              (cause) =>
                new SystemError({
                  subtag: "WorkerdSpawn",
                  message: "Failed to spawn the Workers runtime (workerd) process.",
                  cause,
                }),
            ),
          );

          const unregister = exitHook(() => {
            process.kill(handle.pid, "SIGKILL");
          });

          yield* Effect.addFinalizer(() =>
            handle.kill({ killSignal: "SIGKILL" }).pipe(
              Effect.tap(() => Effect.sync(unregister)),
              Effect.ignore,
            ),
          );

          const stderrRef = yield* Ref.make("");

          const stderrFiber = yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Ref.update(stderrRef, (s) => (s.length === 0 ? line : `${s}\n${line}`)).pipe(
                Effect.andThen(Effect.logError(line)),
              ),
            ),
            Effect.ignore,
            Effect.forkScoped,
          );

          const collectControl = handle.getOutputFd(3).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim() !== ""),
            Stream.map((line) => JSON.parse(line) as ControlMessage),
            Stream.take(count),
            Stream.runCollect,
            Effect.flatMap((messages) =>
              messages.length === count ? Effect.succeed(messages) : Effect.never,
            ),
            Effect.mapError(
              (cause) =>
                new SystemError({
                  subtag: "WorkerdSpawn",
                  message:
                    "The Workers runtime (workerd) process failed while reading control messages.",
                  cause,
                }),
            ),
          );

          const failOnExit = Effect.matchEffect(handle.exitCode, {
            onSuccess: (code) =>
              Fiber.join(stderrFiber).pipe(
                Effect.andThen(Ref.get(stderrRef)),
                Effect.flatMap((stderr) => classifyWorkerdError(stderr, code)),
              ),
            onFailure: () =>
              Fiber.join(stderrFiber).pipe(
                Effect.andThen(Ref.get(stderrRef)),
                Effect.flatMap((stderr) => classifyWorkerdError(stderr, null)),
              ),
          });

          const controlMessages = yield* Effect.raceFirst(collectControl, failOnExit);

          const ports: WorkerdPorts = {};
          for (const message of controlMessages) {
            if (message.event === "listen") {
              ports[message.socket] = message.port;
            }
          }
          return ports;
        },
        (effect) =>
          Effect.retry(effect, {
            while: (error) => error._tag === "SystemError",
            schedule: Schedule.both(Schedule.exponential(50), Schedule.recurs(3)),
          }),
      ),
    });
  }),
);

/**
 * Workerd writes failures to stderr in a few well-known shapes. This
 * classifier inspects the captured stderr and decides whether the failure
 * is a user-facing config error (bad worker script or config) or a
 * lower-level system error (port conflict, internal workerd error, etc.).
 */
const classifyWorkerdError = (
  stderr: string | undefined,
  exitCode: number | null,
): Effect.Effect<never, ConfigError | SystemError> => {
  const text = (stderr ?? "").trim();
  const detail = { stderr: text, exitCode };
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
    const [, service, message] = match ?? [];
    return Effect.fail(
      new ConfigError({
        subtag: "WorkerdUserScript",
        message: message ?? serviceLine,
        hint: service ? `Check the configuration for service "${service}".` : undefined,
        detail: { ...detail, service },
      }),
    );
  }

  // Pattern: address-in-use comes through as a `kj::Exception`.
  if (/Address already in use/i.test(text)) {
    return Effect.fail(
      new ConfigError({
        subtag: "WorkerdAddressInUse",
        message: "The Workers runtime could not bind to the requested address (already in use).",
        hint: "Pick a different port or stop the process using it.",
        detail,
      }),
    );
  }

  return Effect.fail(
    new SystemError({
      subtag: "WorkerdStartFailed",
      message: "The Workers runtime failed to start.",
      detail,
    }),
  );
};
