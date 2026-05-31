import { exitHook } from "@alchemy.run/node-utils/exit-hook";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";
import { allocatePort, isPortAvailable } from "../internal/find-available-port.ts";
import type { Config } from "./Config.ts";
import { serializeConfig } from "./internal/config.serialize.ts";
import * as workerd from "./internal/workerd.ts";

// Distinguishes the temp config files written by concurrent `serve` calls.
let configSeq = 0;

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
        const onStderr = (data: Buffer) => {
          const lines = data.toString().split("\n");
          for (const line of lines) {
            if (line.includes("CODE_MOVED for unknown code block")) continue;
            console.error(line);
          }
        };
        handle.once("error", onError);
        handle.once("spawn", onSpawn);
        handle.stderr?.on("data", onStderr);
        return Effect.sync(() => {
          handle.kill("SIGKILL");
        });
      },
    );
  return Workerd.of({
    compatibilityDate: workerd.compatibilityDate,
    serve: Effect.fn("Workerd.serve")(
      function* (config, args) {
        // Pre-assign a concrete loopback port for each ":0" socket and
        // port-valued arg instead of letting workerd pick ephemeral ports and
        // report them back over the control fd (fd 3): under Bun, child_process
        // intermittently drops that extra pipe, leaving the worker up but
        // unaddressable with no "Started" log and no error. We poll the port for
        // readiness instead, which removes the dependency on fd 3.
        const ports: WorkerdPorts = {};
        const sockets: NonNullable<Config["sockets"]> = [];
        for (const socket of config.sockets ?? []) {
          if (typeof socket.address === "string" && socket.address.endsWith(":0")) {
            const port = yield* allocatePort();
            if (socket.name) ports[socket.name] = port;
            sockets.push({ ...socket, address: `127.0.0.1:${port}` });
          } else {
            // Concrete sockets (e.g. the proxy's fixed :1337) keep their address,
            // but we still record the port so the returned shape is unchanged.
            const port = portOf(socket.address);
            if (socket.name && port !== undefined) ports[socket.name] = port;
            sockets.push(socket);
          }
        }

        const resolvedArgs: Record<string, string | number | boolean> = { ...(args ?? {}) };
        for (const key of ["debug-port", "inspector-addr"] as const) {
          const value = resolvedArgs[key];
          if (typeof value !== "string") continue;
          if (value.endsWith(":0")) {
            const port = yield* allocatePort();
            ports[key] = port;
            resolvedArgs[key] = `127.0.0.1:${port}`;
          } else {
            const port = portOf(value);
            if (port !== undefined) ports[key] = port;
          }
        }

        const resolvedConfig: Config = { ...config, sockets };
        const httpSocket = sockets.find((socket) => socket.name === "http") ?? sockets[0];
        const readinessPort = httpSocket ? portOf(httpSocket.address) : undefined;
        // Whether the readiness port is free *before* we spawn. If it is, a later
        // TCP connect confirms our worker is listening. If it is already taken (a
        // concrete address colliding with another process), workerd can't bind it
        // and will exit, so we must not connect-probe — that would answer from
        // the other listener and falsely report ready.
        const readinessPortFree =
          readinessPort === undefined
            ? undefined
            : yield* isPortAvailable(readinessPort, "127.0.0.1");

        // Pass the config as a file rather than over stdin: the same spawn race
        // can drop the stdin pipe, leaving workerd to read EOF, get no config,
        // and exit 1 within milliseconds. A file path has no such dependency.
        const configPath = NodePath.join(
          NodeOs.tmpdir(),
          `workerd-config-${process.pid}-${configSeq++}.bin`,
        );
        yield* Effect.promise(() =>
          NodeFs.promises.writeFile(configPath, Buffer.from(serializeConfig(resolvedConfig))),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              NodeFs.rmSync(configPath, { force: true });
            } catch {
              // Best effort; the OS reclaims tmpdir entries eventually.
            }
          }),
        );

        const [handle, kill] = yield* spawn(
          workerd.bin,
          [
            "serve",
            "--binary",
            "--experimental",
            ...Object.entries(resolvedArgs).map(([key, value]) =>
              typeof value === "boolean" ? `--${key}` : `--${key}=${value}`,
            ),
            configPath,
          ],
          {
            stdio: ["ignore", "inherit", "pipe"],
          },
        );
        yield* Effect.addFinalizer(() => kill);

        // Readiness: poll the assigned HTTP port until workerd accepts a
        // connection, failing fast if the process exits first.
        yield* Effect.callback<void, ConfigError | SystemError>((resume) => {
          let stderr = "";
          let settled = false;
          let pollTimer: NodeJS.Timeout | undefined;
          let deadline: NodeJS.Timeout | undefined;

          const onStderr = (data: Buffer) => {
            stderr += data.toString();
          };
          const cleanup = () => {
            clearTimeout(pollTimer);
            clearTimeout(deadline);
            handle.stderr?.off("data", onStderr);
            handle.off("close", onExit);
          };
          const settle = (effect: Effect.Effect<void, ConfigError | SystemError>) => {
            if (settled) return;
            settled = true;
            cleanup();
            resume(effect);
          };
          // Use "close" (not "exit") so workerd's stderr is fully drained
          // before we classify the failure — on "exit" the final chunk can
          // still be in flight, which would mislabel an "address in use" bind
          // failure (ConfigError) as a generic SystemError.
          const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
            settle(classifyWorkerdError(stderr, code, signal));
          const probe = () => {
            if (readinessPort === undefined) {
              // No port to confirm a listen against; staying up is our only signal.
              settle(Effect.void);
              return;
            }
            if (readinessPortFree === false) {
              // A pre-existing listener owns the port; wait for workerd's bind
              // failure on exit rather than connecting to the other process.
              return;
            }
            const socket = NodeNet.connect(readinessPort, "127.0.0.1");
            socket.once("connect", () => {
              socket.destroy();
              settle(Effect.void);
            });
            socket.once("error", () => {
              socket.destroy();
              pollTimer = setTimeout(probe, 50);
            });
          };

          handle.stderr?.on("data", onStderr);
          handle.on("close", onExit);
          deadline = setTimeout(
            () =>
              settle(
                new SystemError({
                  subtag: "WorkerdStartTimeout",
                  message: "The Workers runtime (workerd) did not start listening in time.",
                }),
              ),
            30_000,
          );

          probe();

          return Effect.sync(cleanup);
        });
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

// Extract the numeric port from a `host:port` address string.
const portOf = (address: string | undefined): number | undefined => {
  const port = Number(String(address).split(":").pop());
  return Number.isFinite(port) ? port : undefined;
};

const ADDRESS_IN_USE_SUBTAG = "WorkerdAddressInUse" as const;

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
