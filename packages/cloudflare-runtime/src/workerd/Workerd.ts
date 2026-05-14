import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
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
    const spawn = (config: Config, args: Record<string, string | number | boolean> = {}) => {
      const child = NodeChildProcess.spawn(
        workerd.bin,
        [
          "serve",
          "--binary",
          "--experimental",
          "--verbose",
          "--control-fd=3",
          ...Object.entries(args).map(([key, value]) =>
            typeof value === "boolean" ? `--${key}` : `--${key}=${value}`,
          ),
          "-",
        ],
        {
          stdio: ["pipe", "inherit", "pipe", "pipe"],
        },
      );
      const unregister = exitHook(() => {
        child.kill("SIGKILL");
      });
      const kill = () => {
        child.kill("SIGKILL");
        unregister();
      };

      child.stderr?.pipe(process.stderr);

      return {
        ready: Effect.callback<WorkerdPorts, ConfigError | SystemError>((resume) => {
          const count =
            (config.sockets?.length ?? 0) +
            (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
            (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);
          let stderr = "";
          const messages: Array<ControlMessage> = [];
          const onStderr = (data: Buffer) => {
            stderr += data.toString();
          };
          const onControl = (data: Buffer) => {
            messages.push(
              ...data
                .toString()
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as ControlMessage),
            );
            if (messages.length >= count) {
              const ports = messages.reduce((acc, message) => {
                if (message.event === "listen") {
                  acc[message.socket] = message.port;
                }
                return acc;
              }, {} as WorkerdPorts);
              resume(Effect.succeed(ports));
              removeListeners();
            }
          };
          const onError = (error?: Error) => {
            resume(classifyWorkerdStderr(stderr, error));
            removeListeners();
          };
          const onExit = () => {
            onError();
          };
          const removeListeners = () => {
            child.stdio[3]?.off("data", onControl);
            child.stderr?.off("data", onStderr);
            child.off("exit", onExit);
            child.off("error", onError);
          };
          child.stderr!.on("data", onStderr);
          child.stdio[3]!.on("data", onControl);
          child.on("exit", onExit);
          child.on("error", onError);

          child.stdin!.write(Buffer.from(serializeConfig(config)));
          child.stdin!.end();

          return Effect.sync(removeListeners);
        }),
        kill,
      };
    };
    return Workerd.of({
      compatibilityDate: workerd.compatibilityDate,
      serve: Effect.fn("Workerd.serve")((config, args) =>
        Effect.acquireRelease(
          Effect.sync(() => spawn(config, args)),
          (handle) => Effect.sync(() => handle.kill()),
        ).pipe(Effect.flatMap((handle) => handle.ready)),
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
const classifyWorkerdStderr = (
  stderr: string | undefined,
  cause?: Error,
): ConfigError | SystemError => {
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
      cause,
    });
  }

  // Pattern: address-in-use comes through as a `kj::Exception`.
  if (/Address already in use/i.test(text)) {
    return new SystemError({
      subtag: "WorkerdAddressInUse",
      message: "The Workers runtime could not bind to the requested address (already in use).",
      hint: "Pick a different port or stop the process using it.",
      detail: { stderr: text },
      cause,
    });
  }

  return new SystemError({
    subtag: "WorkerdStartFailed",
    message: "The Workers runtime failed to start.",
    detail: { stderr: text },
    cause,
  });
};
