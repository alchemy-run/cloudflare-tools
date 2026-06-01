import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
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

export const WorkerdLive = Layer.sync(Workerd, () => {
  const spawn = (
    command: string,
    args: Array<string>,
    spawnOptions: NodeChildProcess.SpawnOptions,
  ) =>
    Effect.callback<readonly [NodeChildProcess.ChildProcess, Effect.Effect<void>], SystemError>(
      (resume) => {
        const handle = NodeChildProcess.spawn(command, args, spawnOptions);
        const onError = (error: Error) => {
          handle.off("error", onError);
          handle.off("spawn", onSpawn);
          resume(
            Effect.fail(
              new SystemError({
                subtag: "WorkerdSpawn",
                message: "Failed to spawn the Workers runtime (workerd) process.",
                cause: error,
              }),
            ),
          );
        };
        const onSpawn = () => {
          const unregister = exitHook(() => {
            handle.kill("SIGKILL");
          });
          const kill = Effect.sync(() => {
            handle.kill("SIGKILL");
            unregister();
          });
          handle.off("error", onError);
          handle.off("spawn", onSpawn);
          resume(Effect.succeed([handle, kill]));
        };
        handle.once("error", onError);
        handle.once("spawn", onSpawn);
        return Effect.sync(() => {
          handle.kill("SIGKILL");
        });
      },
    );
  return Workerd.of({
    compatibilityDate: workerd.compatibilityDate,
    serve: Effect.fn("Workerd.serve")(
      function* (config, args) {
        const [handle, kill] = yield* spawn(
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
          {
            stdio: ["pipe", "inherit", "pipe", "pipe"],
          },
        );
        yield* Effect.addFinalizer(() => kill);
        const controlMessages = yield* Effect.callback<
          Array<ControlMessage>,
          ConfigError | SystemError
        >((resume) => {
          const count =
            (config.sockets?.length ?? 0) +
            (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
            (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);

          if (
            !handle.stdin ||
            !handle.stderr ||
            !(handle.stdio[3] instanceof NodeStream.Readable)
          ) {
            return resume(
              new SystemError({
                subtag: "WorkerdSpawn",
                message:
                  "The Workers runtime (workerd) process did not have a stdin, stderr, or control fd.",
              }),
            );
          }

          let stderr = "";
          let control = "";

          const onStderr = (data: Buffer) => {
            stderr += data.toString();
          };
          const onControl = (data: Buffer) => {
            control += data.toString();
            const messages = control
              .split("\n")
              .filter((line) => line.trim() !== "")
              .map((line) => JSON.parse(line) as ControlMessage);
            if (messages.length === count) {
              removeListeners();
              resume(Effect.succeed(messages));
            }
          };
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            removeListeners();
            resume(classifyWorkerdError(stderr, code, signal));
          };
          const removeListeners = () => {
            handle.stderr?.off("data", onStderr);
            handle.stdio[3]?.off("data", onControl);
            handle.off("exit", onExit);
          };
          handle.stderr?.on("data", onStderr);
          handle.stdio[3]?.on("data", onControl);
          handle.on("exit", onExit);

          handle.stdin?.write(Buffer.from(serializeConfig(config)));
          handle.stdin?.end();

          return Effect.sync(removeListeners);
        });
        yield* Effect.sync(() => {
          handle.stderr?.pipe(process.stderr);
        });
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
});

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
