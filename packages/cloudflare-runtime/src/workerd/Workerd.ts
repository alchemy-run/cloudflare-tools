import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";
import type { Config } from "./Config.ts";
import { serializeConfig } from "./internal/config.serialize.ts";
import * as workerd from "./internal/workerd.ts";

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

interface ProcessHandle {
  /** Writes the config to the process's stdin. This can be omitted if the config is passed as an argument to the process. */
  readonly configure?: () => Effect.Effect<void, SystemError>;
  /** Waits for the process to listen on the given number of sockets. */
  readonly control: (count: number) => Effect.Effect<Array<ControlMessage>, SystemError>;
  /** Resumes with an error if the process fails to start. */
  readonly error: () => Effect.Effect<never, ConfigError | SystemError>;
  /** Pipes the process's stderr to the console. Called after initialization is complete. */
  readonly pipe: () => Effect.Effect<void, never, Scope.Scope>;
  /** Kills the process. */
  readonly kill: () => void;
}

const make = (
  spawn: (
    command: string,
    args: Array<string>,
    config: Buffer,
  ) => Effect.Effect<ProcessHandle, ConfigError | SystemError>,
) =>
  Workerd.of({
    compatibilityDate: workerd.compatibilityDate,
    serve: Effect.fn("Workerd.serve")(
      function* (config, args) {
        const handle = yield* spawn(
          workerd.bin,
          [
            "serve",
            "--binary",
            "--experimental",
            "--control-fd=3",
            ...Object.entries(args ?? {}).map(([key, value]) =>
              typeof value === "boolean" ? `--${key}` : `--${key}=${value}`,
            ),
            "-",
          ],
          Buffer.from(serializeConfig(config)),
        );
        // Scope finalizers may not run if the parent exits, so we use an exit hook to ensure we always kill the process.
        const unregister = exitHook(() => handle.kill());
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            handle.kill();
            unregister();
          }),
        );
        if (handle.configure) {
          yield* handle.configure();
        }
        const count =
          (config.sockets?.length ?? 0) +
          (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
          (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);
        const control = yield* Effect.raceAllFirst([handle.control(count), handle.error()]);
        yield* handle.pipe();
        const ports: WorkerdPorts = {};
        for (const message of control) {
          if (message.event === "listen") {
            ports[message.socket] = message.port;
          }
        }
        return ports;
      },
      Effect.retry({
        while: (error) => error._tag === "SystemError",
        schedule: Schedule.both(Schedule.exponential(50), Schedule.recurs(3)),
      }),
    ),
  });

const makeBun = () =>
  make((command, args, config) =>
    Effect.sync(() =>
      Bun.spawn({
        cmd: [command, ...args],
        stdio: [config, "pipe", "pipe", "pipe"],
        killSignal: "SIGKILL",
      }),
    ).pipe(
      Effect.map((child) => ({
        control: (count) =>
          Effect.callback<Array<ControlMessage>, SystemError>((resume, signal) => {
            if (!child.stdio[3]) {
              return resume(
                new SystemError({
                  subtag: "WorkerdSpawn",
                  message: "The workerd process did not have a control fd.",
                }),
              );
            }
            const file = Bun.file(child.stdio[3]);
            const collect = async () => {
              let lines = "";
              for await (const chunk of file.stream().pipeThrough(new TextDecoderStream(), {
                signal,
              })) {
                lines += chunk;
                const messages = lines
                  .split("\n")
                  .filter((line) => line.trim() !== "")
                  .map((line) => JSON.parse(line) as ControlMessage);
                if (messages.length === count) {
                  return resume(Effect.succeed(messages));
                }
              }
            };
            // Ignore errors here and let the error callback handle it instead.
            // Errors here are a symptom; the error callback reports the actual cause.
            void collect().catch(() => null);
          }),
        error: () =>
          Effect.callback<never, ConfigError | SystemError>((resume, signal) => {
            const collect = async () => {
              let stderr = "";
              for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream(), {
                signal,
              })) {
                stderr += chunk;
              }
              return stderr;
            };
            void collect()
              .catch(() => "Bun child process stderr is empty.")
              .then((stderr) =>
                resume(classifyWorkerdError(stderr, child.exitCode, child.signalCode)),
              );
          }),
        pipe: () =>
          Effect.promise((signal) =>
            Promise.all([
              child.stdout.pipeTo(
                new WritableStream({
                  write(chunk) {
                    process.stdout.write(chunk);
                  },
                }),
                { signal },
              ),
              child.stderr.pipeTo(
                new WritableStream({
                  write(chunk) {
                    process.stderr.write(chunk);
                  },
                }),
                { signal },
              ),
            ]),
          ).pipe(Effect.forkScoped),
        kill: () => child.kill("SIGKILL"),
      })),
    ),
  );

const makeNode = () =>
  make((command, args, config) =>
    Effect.try({
      try: () =>
        NodeChildProcess.spawn(command, args, {
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          killSignal: "SIGKILL",
        }),
      catch: (error) =>
        new SystemError({
          subtag: "WorkerdSpawn",
          message: "Failed to spawn the Workers runtime (workerd) process.",
          cause: error,
        }),
    }).pipe(
      Effect.tap((child) =>
        Effect.callback<void, SystemError>((resume) => {
          const onSpawn = () => {
            child.off("error", onError);
            resume(Effect.void);
          };
          const onError = (error: unknown) => {
            resume(
              new SystemError({
                subtag: "WorkerdStart",
                message: "Failed to start the Workers runtime (workerd) process.",
                cause: error,
              }),
            );
          };
          child.once("spawn", onSpawn);
          child.once("error", onError);
          return Effect.sync(() => {
            child.kill("SIGKILL");
            child.off("spawn", onSpawn);
            child.off("error", onError);
          });
        }),
      ),
      Effect.map((child) => ({
        configure: () =>
          Effect.callback((resume) => {
            const onError = (
              cause: unknown,
              message: string = "Failed to write to the workerd process stdin.",
            ) => {
              resume(new SystemError({ subtag: "WorkerdSpawn", message, cause }));
            };
            if (!child.stdin) {
              return onError(undefined, "The workerd process did not have a stdin.");
            }
            child.stdin.on("error", onError);
            child.stdin.end(config, () => {
              resume(Effect.void);
              child.stdin?.off("error", onError);
            });
            return Effect.sync(() => {
              child.stdin?.off("error", onError);
            });
          }),
        control: (count) =>
          Effect.callback((resume) => {
            const pipe = child.stdio[3];
            if (!pipe) {
              return resume(
                new SystemError({
                  subtag: "WorkerdSpawn",
                  message: "The workerd process did not have a control fd.",
                }),
              );
            }
            let lines = "";
            const onEnd = () => {
              pipe.off("data", onData);
              if ("closed" in pipe && !pipe.closed) {
                pipe.destroy();
              }
            };
            const onData = (data: Buffer) => {
              lines += data.toString();
              const messages = lines
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as ControlMessage);
              if (messages.length === count) {
                onEnd();
                return resume(Effect.succeed(messages));
              }
            };
            // We intentionally don't listen for `end` or `error` because:
            // - workerd doesn't close the pipe itself; we have to do it ourselves when we have all our messages
            // - errors from here are a symptom and don't tell us what's actually wrong, so we let the error callback handle it
            pipe.on("data", onData);
            return Effect.sync(onEnd);
          }),
        error: () =>
          Effect.callback((resume) => {
            let stderr = "";
            const onData = (data: Buffer) => {
              stderr += data.toString();
            };
            const onError = () => {
              resume(
                classifyWorkerdError(
                  stderr || "Node child process stderr is empty.",
                  child.exitCode,
                  child.signalCode,
                ),
              );
            };
            child.stderr.on("data", onData);
            child.stderr.on("end", onError);
            child.stderr.on("error", onError);
            return Effect.sync(() => {
              child.stderr?.off("data", onData);
              child.stderr?.off("end", onError);
              child.stderr?.off("error", onError);
            });
          }),
        pipe: () => {
          const onStdout = (chunk: Buffer) => {
            process.stdout.write(chunk);
          };
          const onStderr = (chunk: Buffer) => {
            process.stderr.write(chunk);
          };
          return Effect.acquireRelease(
            Effect.sync(() => {
              child.stdout.on("data", onStdout);
              child.stderr.on("data", onStderr);
            }),
            () =>
              Effect.sync(() => {
                child.stdout.off("data", onStdout);
                child.stderr.off("data", onStderr);
              }),
          );
        },
        kill: () => child.kill("SIGKILL"),
      })),
    ),
  );

export const WorkerdLive = Layer.sync(Workerd, () =>
  typeof globalThis.Bun !== "undefined" ? makeBun() : makeNode(),
);

const ADDRESS_IN_USE_SUBTAG = "AddressInUse" as const;

/**
 * Workerd writes failures to stderr in a few well-known shapes. This
 * classifier inspects the captured stderr and decides whether the failure
 * is a user-facing config error (bad worker script or config) or a
 * lower-level system error (port conflict, internal workerd error, etc.).
 */
const classifyWorkerdError = (
  stderr: string | undefined,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): ConfigError | SystemError => {
  const text = (stderr ?? "").trim();
  const detail = { stderr: text, exitCode, signal };
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
    return new ConfigError({
      subtag: "WorkerdUserScript",
      message: message ?? serviceLine,
      hint: service ? `Check the configuration for service "${service}".` : undefined,
      detail: { ...detail, service },
    });
  }

  // Pattern: address-in-use comes through as a `kj::Exception`. The offending
  // address is reported via workerd's `toString() = <address>` suffix.
  if (/Address already in use/i.test(text)) {
    const address = text.match(/toString\(\) = (\S+)/)?.[1];
    return new ConfigError({
      subtag: ADDRESS_IN_USE_SUBTAG,
      message: address
        ? `The Workers runtime could not bind to ${address} (already in use).`
        : "The Workers runtime could not bind to the requested address (already in use).",
      hint: "Pick a different port or stop the process using it.",
      detail: { ...detail, address },
    });
  }

  return new SystemError({
    subtag: "WorkerdStartFailed",
    message: "The Workers runtime failed to start.",
    detail,
  });
};

export const isAddressInUseError = (error: ConfigError | SystemError): error is ConfigError =>
  error._tag === "ConfigError" && error.subtag === ADDRESS_IN_USE_SUBTAG;
