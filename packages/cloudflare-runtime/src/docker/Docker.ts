import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as NodePath from "node:path";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";

/**
 * Default egress interceptor image. workerd runs this sidecar to route
 * outbound HTTP from containers back through the runtime. Mirrors Miniflare's
 * `DEFAULT_CONTAINER_EGRESS_INTERCEPTOR_IMAGE`; overridable via the
 * `MINIFLARE_CONTAINER_EGRESS_IMAGE` environment variable.
 */
export const DEFAULT_CONTAINER_EGRESS_INTERCEPTOR_IMAGE =
  "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";

/** Prefix used for locally built/pulled dev container images. */
export const DEV_CONTAINER_PREFIX = "cloudflare-dev";

/**
 * Compute the dev image tag for a container-backed Durable Object class. The
 * class name is the repository and the build id is the tag, namespaced under
 * {@link DEV_CONTAINER_PREFIX} so cleanup can target only our images.
 */
export const getDevContainerImageName = (className: string, buildId: string): string =>
  `${DEV_CONTAINER_PREFIX}/${className.toLowerCase()}:${buildId}`;

/** Generate a short, per-session container build id. */
export const generateContainerBuildId = (): string => randomUUID().slice(0, 8);

export interface DockerConfig {
  /** Whether containers should be prepared at all. Defaults to `true`. */
  readonly enabled?: boolean;
  /** Path to the Docker CLI. Defaults to `WRANGLER_DOCKER_BIN` or `docker`. */
  readonly dockerPath?: string;
  /** Docker socket/host passed to workerd. Defaults to a resolved value. */
  readonly socketPath?: string;
  /** Override for the egress interceptor sidecar image. */
  readonly egressInterceptorImage?: string;
}

export interface BuildImageOptions {
  readonly tag: string;
  readonly dockerfile: string;
  readonly context?: string;
  readonly buildArgs?: Record<string, string>;
}

export interface PullImageOptions {
  readonly tag: string;
  readonly imageUri: string;
}

export interface DockerApi {
  /** Resolved Docker CLI path. */
  readonly dockerPath: string;
  /** Resolved Docker socket/host, suitable for the workerd container engine. */
  readonly socketPath: string;
  /** Resolved egress interceptor sidecar image. */
  readonly egressInterceptorImage: string;
  /** Whether container preparation is enabled. */
  readonly enabled: boolean;
  /** Verify the Docker CLI is installed and the daemon is reachable. */
  readonly verifyInstalled: (numberOfContainers: number) => Effect.Effect<void, SystemError>;
  /** Build a local image from a Dockerfile and tag it. */
  readonly build: (options: BuildImageOptions) => Effect.Effect<void, SystemError>;
  /** Pull a registry image and re-tag it with the dev tag. */
  readonly pull: (options: PullImageOptions) => Effect.Effect<void, SystemError>;
  /** Fail if the image does not expose any ports (unreachable in local dev). */
  readonly checkExposedPorts: (options: {
    tag: string;
    className: string;
  }) => Effect.Effect<void, ConfigError>;
  /** Remove stale `cloudflare-dev` tags for this image from prior sessions. */
  readonly cleanupDuplicateImageTags: (tag: string) => Effect.Effect<void>;
  /** Pull the egress interceptor sidecar image. */
  readonly pullEgressInterceptorImage: () => Effect.Effect<void, SystemError>;
  /** Force-remove any containers created from the given image tags. */
  readonly cleanupContainers: (imageTags: ReadonlySet<string>) => Effect.Effect<void>;
}

export class Docker extends Context.Service<Docker, DockerApi>()(
  "cloudflare-runtime/docker/Docker",
) {}

const isWindows = process.platform === "win32";

const defaultDockerPath = (): string => process.env.WRANGLER_DOCKER_BIN ?? "docker";

/**
 * Resolve the Docker host as workerd expects it:
 * 1. `WRANGLER_DOCKER_HOST`
 * 2. `DOCKER_HOST`
 * 3. the active `docker context`'s endpoint
 * 4. a platform default
 */
const resolveDockerHost = (dockerPath: string): string => {
  if (process.env.WRANGLER_DOCKER_HOST) {
    return process.env.WRANGLER_DOCKER_HOST;
  }
  if (process.env.DOCKER_HOST) {
    return process.env.DOCKER_HOST;
  }
  const fromContext = getDockerSocketFromContext(dockerPath);
  if (fromContext) {
    return fromContext;
  }
  return isWindows ? "//./pipe/docker_engine" : "unix:///var/run/docker.sock";
};

interface DockerContext {
  Current: boolean;
  DockerEndpoint: string;
}

const getDockerSocketFromContext = (dockerPath: string): string | null => {
  try {
    const output = NodeChildProcess.execFileSync(
      dockerPath,
      ["context", "ls", "--format", "json"],
      { encoding: "utf8" },
    ).trim();
    const contexts = output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as DockerContext);
    const current = contexts.find((context) => context.Current === true);
    return current?.DockerEndpoint || null;
  } catch {
    // Fall back to platform defaults if context inspection fails.
    return null;
  }
};

interface RunOptions {
  /** Written to the child's stdin (used to pipe a Dockerfile to `build`). */
  readonly stdin?: string;
  /** Capture and return stdout instead of inheriting it. */
  readonly captureStdout?: boolean;
}

/**
 * Spawn the Docker CLI as an Effect. The child is killed if the effect is
 * interrupted (e.g. the runtime scope closes mid-build).
 */
const runDocker = (
  dockerPath: string,
  args: Array<string>,
  options: RunOptions = {},
): Effect.Effect<string, SystemError> =>
  Effect.callback<string, SystemError>((resume) => {
    const child = NodeChildProcess.spawn(dockerPath, args, {
      stdio: [
        options.stdin !== undefined ? "pipe" : "ignore",
        options.captureStdout ? "pipe" : "inherit",
        "pipe",
      ],
      // Detach so we can kill the whole process group on abort. Windows does
      // not support negative-PID group kills, so we only detach elsewhere.
      detached: !isWindows,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    let settled = false;
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resume(
        new SystemError({
          subtag: "DockerSpawn",
          message: `Failed to run the Docker CLI (${dockerPath} ${args[0] ?? ""}).`,
          hint: "Is Docker installed and on your PATH? Set WRANGLER_DOCKER_BIN to override the Docker CLI path.",
          cause: error,
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resume(Effect.succeed(stdout.trim()));
      } else {
        resume(
          new SystemError({
            subtag: "DockerCommandFailed",
            message: `Docker command \`${args[0] ?? ""}\` exited with code ${code}.`,
            detail: { args, stderr: stderr.trim() },
          }),
        );
      }
    });

    return Effect.sync(() => {
      if (child.pid === undefined) return;
      try {
        if (isWindows) {
          child.kill();
        } else {
          child.unref();
          process.kill(-child.pid);
        }
      } catch {
        // The process may already have exited; nothing to clean up.
      }
    });
  });

export const layer = (config: DockerConfig = {}): Layer.Layer<Docker> =>
  Layer.sync(Docker, () => {
    const dockerPath = config.dockerPath ?? defaultDockerPath();
    const socketPath = config.socketPath ?? resolveDockerHost(dockerPath);
    const egressInterceptorImage =
      config.egressInterceptorImage ??
      process.env.MINIFLARE_CONTAINER_EGRESS_IMAGE ??
      DEFAULT_CONTAINER_EGRESS_INTERCEPTOR_IMAGE;
    const enabled = config.enabled ?? true;

    const inspectFormat = (tag: string, formatString: string) =>
      runDocker(dockerPath, ["image", "inspect", tag, "--format", formatString], {
        captureStdout: true,
      });

    return Docker.of({
      dockerPath,
      socketPath,
      egressInterceptorImage,
      enabled,

      verifyInstalled: (numberOfContainers) =>
        runDocker(dockerPath, ["info"], { captureStdout: true }).pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new SystemError({
                subtag: "DockerNotRunning",
                message: `The Docker CLI is needed to prepare ${
                  numberOfContainers === 1 ? "the container image" : "container images"
                } for local development, but could not be reached.`,
                hint: "Start Docker (e.g. open Docker Desktop) and try again. If you use a Docker-compatible CLI such as Podman, set WRANGLER_DOCKER_BIN to its path and DOCKER_HOST to its socket. To skip containers entirely, disable them in your runtime config.",
              }),
          ),
        ),

      build: (options) => {
        const buildArgs: Array<string> = [
          "build",
          "--load",
          "-t",
          options.tag,
          "--platform",
          "linux/amd64",
          "--provenance=false",
        ];
        for (const [name, value] of Object.entries(options.buildArgs ?? {})) {
          buildArgs.push("--build-arg", `${name}=${value}`);
        }
        // Pipe the Dockerfile via stdin so the build context can be any directory.
        buildArgs.push("-f", "-");
        buildArgs.push(options.context ?? NodePath.dirname(options.dockerfile));
        return Effect.try({
          try: () => readFileSync(options.dockerfile, "utf8"),
          catch: (error) =>
            new SystemError({
              subtag: "DockerfileRead",
              message: `Failed to read Dockerfile at ${options.dockerfile}.`,
              cause: error,
            }),
        }).pipe(
          Effect.flatMap((dockerfile) => runDocker(dockerPath, buildArgs, { stdin: dockerfile })),
          Effect.asVoid,
        );
      },

      pull: (options) =>
        runDocker(dockerPath, ["pull", options.imageUri, "--platform", "linux/amd64"]).pipe(
          Effect.andThen(() => runDocker(dockerPath, ["tag", options.imageUri, options.tag])),
          Effect.asVoid,
        ),

      checkExposedPorts: ({ tag, className }) =>
        inspectFormat(tag, "{{ len .Config.ExposedPorts }}").pipe(
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: (output) =>
              output === "0"
                ? Effect.fail(
                    new ConfigError({
                      subtag: "ContainerNoExposedPorts",
                      message: `The container for "${className}" does not expose any ports.`,
                      hint: "Add an EXPOSE instruction to the Dockerfile for any ports you intend to connect to.",
                    }),
                  )
                : Effect.void,
          }),
        ),

      cleanupDuplicateImageTags: (tag) =>
        inspectFormat(tag, "{{ range .RepoTags }}{{ . }}\n{{ end }}").pipe(
          Effect.flatMap((output) => {
            const currentTag = imageTagSuffix(tag);
            const stale = output
              .split("\n")
              .map((line) => line.trim())
              .filter(
                (repoTag) =>
                  repoTag.startsWith(DEV_CONTAINER_PREFIX) &&
                  imageTagSuffix(repoTag) !== currentTag,
              );
            return stale.length > 0 ? runDocker(dockerPath, ["rmi", ...stale]) : Effect.succeed("");
          }),
          Effect.asVoid,
          Effect.ignore,
        ),

      pullEgressInterceptorImage: () =>
        runDocker(dockerPath, ["pull", egressInterceptorImage, "--platform", "linux/amd64"]).pipe(
          Effect.asVoid,
        ),

      cleanupContainers: (imageTags) =>
        Effect.forEach(
          imageTags,
          (tag) =>
            runDocker(dockerPath, [
              "ps",
              "-a",
              "--filter",
              `ancestor=${tag}`,
              "--format",
              "{{.ID}}",
            ]).pipe(
              Effect.map((output) => output.split("\n").filter((line) => line.trim() !== "")),
              Effect.flatMap((ids) =>
                ids.length > 0
                  ? runDocker(dockerPath, ["rm", "--force", ...ids])
                  : Effect.succeed(""),
              ),
              Effect.ignore,
            ),
          { concurrency: "unbounded", discard: true },
        ),
    });
  });

const imageTagSuffix = (imageTag: string): string | undefined => {
  const index = imageTag.lastIndexOf(":");
  return index === -1 ? undefined : imageTag.slice(index + 1);
};
