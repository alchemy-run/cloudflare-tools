import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import { Deferred } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const make = <T>(
  spawn: (
    command: string,
    args: Array<string>,
    config: Buffer,
  ) => Effect.Effect<T, ConfigError | SystemError>,
  options: {
    control: (handle: T, count: number) => Effect.Effect<Array<ControlMessage>, SystemError>;
    error: (handle: T) => Effect.Effect<never, ConfigError | SystemError>;
    pipe: (handle: T) => Effect.Effect<void, never, Scope.Scope>;
    kill: (handle: T) => void;
  },
) => {
  return Workerd.of({
    compatibilityDate: workerd.compatibilityDate,
    serve: Effect.fn("Workerd.serve")(function* (config, args) {
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
      const unregister = exitHook(() => options.kill(handle));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          options.kill(handle);
          unregister();
        }),
      );
      const count =
        (config.sockets?.length ?? 0) +
        (typeof args?.["debug-port"] !== "undefined" ? 1 : 0) +
        (typeof args?.["inspector-addr"] !== "undefined" ? 1 : 0);
      const control = yield* Effect.raceAllFirst([
        options.control(handle, count),
        options.error(handle),
      ]);
      yield* options.pipe(handle);
      const ports: WorkerdPorts = {};
      for (const message of control) {
        if (message.event === "listen") {
          ports[message.socket] = message.port;
        }
      }
      return ports;
    }),
  });
};

const makeBun = () =>
  make(
    (command, args, config) =>
      Effect.sync(() =>
        Bun.spawn({
          cmd: [command, ...args],
          stdio: [config, "inherit", "pipe", "pipe"],
          killSignal: "SIGKILL",
        }),
      ),
    {
      // control: (child, count) => {
      //   const deferred = Deferred.makeUnsafe<Array<ControlMessage>, SystemError>();
      //   return Effect.tryPromise(async (signal) => {
      //     if (!child.stdio[3]) {
      //       return Deferred.doneUnsafe(
      //         deferred,
      //         new SystemError({
      //           subtag: "WorkerdSpawn",
      //           message: "The workerd process did not have a control fd.",
      //         }),
      //       );
      //     }
      //     const file = Bun.file(child.stdio[3]!);
      //     let lines = "";
      //     for await (const chunk of file
      //       .stream()
      //       .pipeThrough(new TextDecoderStream(), { signal })) {
      //       lines += chunk;
      //       const messages = lines
      //         .split("\n")
      //         .filter((line) => line.trim() !== "")
      //         .map((line) => JSON.parse(line) as ControlMessage);
      //       if (messages.length === count) {
      //         return Deferred.doneUnsafe(deferred, Effect.succeed(messages));
      //       }
      //     }
      //   }).pipe(
      //     Effect.ignore,
      //     Effect.flatMap(() => Deferred.await(deferred)),
      //   );
      // },
      control: (child, count) =>
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
          const stream = async () => {
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
          void stream();
        }),
      error: (child) => {
        const deferred = Deferred.makeUnsafe<never, ConfigError | SystemError>();
        return Effect.tryPromise(async (signal) => {
          let lines = "";
          for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream(), {
            signal,
          })) {
            lines += chunk;
          }
          Deferred.doneUnsafe(
            deferred,
            classifyWorkerdError(lines, child.exitCode, child.signalCode),
          );
        }).pipe(
          Effect.ignore,
          Effect.flatMap(() => Deferred.await(deferred)),
        );
      },
      pipe: () => Effect.void,
      kill: (child) => child.kill("SIGKILL"),
    },
  );

const makeNode = () =>
  make(
    (command, args, config) =>
      Effect.callback<NodeChildProcess.ChildProcess, SystemError>((resume) => {
        const child = NodeChildProcess.spawn(command, args, {
          stdio: ["pipe", "inherit", "pipe", "pipe"],
          killSignal: "SIGKILL",
        });
        child.on("error", (error) => {
          resume(
            new SystemError({
              subtag: "WorkerdSpawn",
              message: "Failed to spawn the Workers runtime (workerd) process.",
              cause: error,
            }),
          );
        });
        child.on("spawn", () => {
          child.stdin?.on("finish", () => {
            resume(Effect.succeed(child));
          });
          child.stdin?.write(config);
          child.stdin?.end();
        });
        return Effect.sync(() => {
          child.kill("SIGKILL");
        });
      }),
    {
      control: (child, count) =>
        Effect.callback<Array<ControlMessage>, SystemError>((resume) => {
          if (!child.stdio[3]) {
            return resume(
              new SystemError({
                subtag: "WorkerdSpawn",
                message: "The workerd process did not have a control fd.",
              }),
            );
          }
          let lines = "";
          const onData = (data: Buffer) => {
            lines += data.toString();
            const messages = lines
              .split("\n")
              .filter((line) => line.trim() !== "")
              .map((line) => JSON.parse(line) as ControlMessage);
            if (messages.length === count) {
              return resume(Effect.succeed(messages));
            }
          };
          child.stdio[3].on("data", onData);
          return Effect.sync(() => {
            child.stdio[3]?.off("data", onData);
          });
        }),
      error: (child) =>
        Effect.callback<never, ConfigError | SystemError>((resume) => {
          let lines = "";
          const onData = (data: Buffer) => {
            lines += data.toString();
          };
          const onError = () => {
            resume(classifyWorkerdError(lines, child.exitCode, child.signalCode));
          };
          child.stderr?.on("data", onData);
          child.stderr?.on("end", onError);
          child.on("exit", onError);
          return Effect.sync(() => {
            child.stderr?.off("data", onData);
            child.stderr?.off("end", onError);
            child.off("exit", onError);
          });
        }),
      pipe: () => Effect.void,
      kill: (child) => child.kill("SIGKILL"),
    },
  );

export const WorkerdLive = Layer.sync(Workerd, () => {
  if (typeof Bun !== "undefined") {
    return makeBun();
  }
  return makeNode();
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
