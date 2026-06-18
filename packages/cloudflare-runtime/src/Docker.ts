import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeChildProcess from "node:child_process";
import { ConfigError, SystemError } from "./RuntimeError.shared.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";

export class Docker extends Context.Service<
  Docker,
  {
    readonly getWorkerdDockerConfiguration: Effect.Effect<
      WorkerdConfig.Worker_ContainerEngine,
      SystemError
    >;
    readonly generateImageTag: (className: string, suffix?: string) => string;
    readonly build: (tag: string, image: ContainerImage.Build) => Effect.Effect<void, SystemError>;
    readonly pull: (tag: string, image: ContainerImage.Pull) => Effect.Effect<void, SystemError>;
    readonly validate: (tag: string) => Effect.Effect<void, ConfigError>;
    readonly removeStaleImageTags: (tag: string) => Effect.Effect<void, SystemError>;
    readonly removeContainer: (tag: string) => Effect.Effect<void, SystemError>;
    readonly removeContainerSync: (tag: string) => void;
  }
>()("cloudflare-runtime/Docker") {}

export type ContainerImage = ContainerImage.Build | ContainerImage.Pull | ContainerImage.Ref;

export declare namespace ContainerImage {
  export interface Build {
    readonly dockerfile: string;
    readonly context?: string;
    readonly buildArgs?: Record<string, string>;
  }
  export interface Pull {
    readonly imageUri: string;
  }
  export interface Ref {
    readonly tag: string;
  }
}

const DEFAULT_DOCKER_HOST =
  process.platform === "win32" ? "//./pipe/docker_engine" : "unix:///var/run/docker.sock";
const DEV_CONTAINER_PREFIX = "alchemy-dev";

const DockerHost = Config.string("DOCKER_HOST");
const DockerBin = Config.string("DOCKER_BIN").pipe(Config.orElse(() => Config.succeed("docker")));
const ContainerEgressInterceptorImage = Config.string("CONTAINER_EGRESS_INTERCEPTOR_IMAGE").pipe(
  Config.orElse(() =>
    Config.succeed(
      "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8",
    ),
  ),
);

export const DockerLive = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const bin = yield* DockerBin;
    const containerEgressInterceptorImage = yield* ContainerEgressInterceptorImage;

    const getSocketPathFromContext = () =>
      ChildProcess.make(bin, ["context", "ls", "--format", "json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      }).pipe(
        spawner.spawn,
        Effect.flatMap((child) =>
          child.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.trim() !== ""),
            Stream.map((line) => JSON.parse(line) as { Current: boolean; DockerEndpoint: string }),
            Stream.runCollect,
            Effect.flatMap((items) => {
              const endpoint = items.find((item) => item.Current)?.DockerEndpoint;
              return endpoint
                ? Effect.succeed(endpoint)
                : Effect.fail(
                    new ConfigError({
                      subtag: "DockerHostNotFound",
                      message: "Docker host not found",
                    }),
                  );
            }),
          ),
        ),
        Effect.scoped,
      );

    const run = (args: Array<string>, stdin: ChildProcess.CommandInput = "ignore") =>
      ChildProcess.make(bin, args, {
        stdin,
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      }).pipe(
        spawner.spawn,
        Effect.flatMap((child) =>
          Effect.all(
            {
              exitCode: child.exitCode,
              stdout: child.stdout.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
              ),
              stderr: child.stderr.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
              ),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.scoped,
      );

    const pull = ({ imageUri }: ContainerImage.Pull) =>
      run(["pull", imageUri, "--platform", "linux/amd64"]).pipe(
        Effect.mapError(
          (cause) =>
            new SystemError({
              subtag: "DockerPullFailed",
              message: `Failed to pull image "${imageUri}".`,
              hint: "Ensure Docker is running and the image is available.",
              detail: { bin, imageUri },
              cause,
            }),
        ),
        Effect.flatMap((result) => {
          if (result.exitCode !== 0) {
            return Effect.fail(
              new SystemError({
                subtag: "DockerPullFailed",
                message: `Failed to pull image "${imageUri}".`,
                hint: "Ensure Docker is running and the image is available.",
                detail: {
                  bin,
                  imageUri,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                },
              }),
            );
          }
          return Effect.succeed(result.stdout);
        }),
      );

    const inspect = (tag: string, format: string) =>
      Effect.map(run(["image", "inspect", tag, "--format", format]), (result) => result.stdout);

    const list = (ancestor: string) =>
      run([
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `ancestor=${ancestor}`,
        "--format",
        "{{.ID}} {{.Names}} {{.Image}}",
      ]).pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
              const [id, name, image] = line.split(" ");
              return { id, name, image };
            })
            .filter((container) => container.image === ancestor),
        ),
      );

    return Docker.of({
      getWorkerdDockerConfiguration: yield* DockerHost.pipe(
        Effect.catchTag("ConfigError", getSocketPathFromContext),
        Effect.orElseSucceed(() => DEFAULT_DOCKER_HOST),
        Effect.tap(() => pull({ imageUri: containerEgressInterceptorImage })),
        Effect.map((socketPath) => ({
          localDocker: {
            socketPath,
            containerEgressInterceptorImage,
          },
        })),
        Effect.cached,
      ),
      generateImageTag: (className, suffix = crypto.randomUUID().slice(0, 8)) =>
        `${DEV_CONTAINER_PREFIX}/${className.toLowerCase()}:${suffix}`,
      build: (tag, image) =>
        Effect.suspend(() => {
          const args = [
            "build",
            "--load",
            "-t",
            tag,
            "--platform",
            "linux/amd64",
            "--provenance=false",
            ...Object.entries(image.buildArgs ?? {}).map(
              ([name, value]) => `--build-arg ${name}=${value}`,
            ),
            "-f",
            "-",
            path.resolve(image.context ?? path.dirname(image.dockerfile)),
          ];
          return run(args, fs.stream(image.dockerfile)).pipe(
            Effect.withLogSpan(`docker: build ${tag}`),
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new SystemError({
                  subtag: "DockerBuildFailed",
                  message: `Failed to build image "${tag}".`,
                  cause,
                }),
            ),
          );
        }),
      pull: (tag, image) =>
        pull(image).pipe(
          Effect.andThen(
            run(["tag", image.imageUri, tag]).pipe(
              Effect.mapError(
                (cause) =>
                  new SystemError({
                    subtag: "DockerTagFailed",
                    message: `Failed to tag image "${image.imageUri}" as "${tag}".`,
                    cause,
                  }),
              ),
            ),
          ),
          Effect.withLogSpan(`docker: pull ${image.imageUri}`),
          Effect.asVoid,
        ),
      validate: (tag) =>
        inspect(tag, "{{ len .Config.ExposedPorts }}").pipe(
          Effect.withLogSpan(`docker: inspect ${tag} for exposed ports`),
          Effect.orElseSucceed(() => "0"),
          Effect.flatMap((output) =>
            output === "0"
              ? Effect.fail(
                  new ConfigError({
                    subtag: "ContainerNoExposedPorts",
                    message: `The container for "${tag}" does not expose any ports.`,
                    hint: "Add an EXPOSE instruction to the Dockerfile for any ports you intend to connect to.",
                  }),
                )
              : Effect.void,
          ),
        ),
      removeStaleImageTags: (tag) =>
        inspect(tag, "{{ range .RepoTags }}{{ . }}\n{{ end }}").pipe(
          Effect.flatMap((output) => {
            const image = parseImageTag(tag);
            if (!image.suffix) return Effect.void;
            const stale = output
              .split("\n")
              .map((line) => line.trim())
              .filter((repoTag) => {
                const repoImage = parseImageTag(repoTag);
                return (
                  repoImage.name === image.name &&
                  !!repoImage.suffix &&
                  repoImage.suffix !== image.suffix
                );
              });
            return stale.length > 0 ? Effect.asVoid(run(["rmi", ...stale])) : Effect.void;
          }),
          Effect.withLogSpan(`docker: remove stale images for ${tag}`),
          Effect.ignore,
        ),
      removeContainer: (tag) =>
        list(tag).pipe(
          Effect.flatMap((containers) => {
            if (containers.length === 0) return Effect.void;
            return Effect.asVoid(
              run([
                "rm",
                "--force",
                ...containers.flatMap((container) => [container.id, `${container.name}-proxy`]),
              ]),
            );
          }),
          Effect.withLogSpan(`docker: remove containers for ${tag}`),
          Effect.mapError(
            (cause) =>
              new SystemError({
                subtag: "DockerRemoveContainerFailed",
                message: `Failed to remove containers for "${tag}".`,
                cause,
              }),
          ),
        ),
      removeContainerSync: (tag) => {
        try {
          const output = NodeChildProcess.execFileSync(
            bin,
            [
              "ps",
              "-a",
              "--no-trunc",
              "--filter",
              `ancestor=${tag}`,
              "--format",
              "{{.ID}} {{.Names}} {{.Image}}",
            ],
            {
              stdio: "pipe",
              encoding: "utf-8",
            },
          );
          const containers = output
            .split("\n")
            .map((line) => {
              const [id, name, image] = line.split(" ");
              return { id, name, image };
            })
            .filter((container) => container.image === tag);
          if (containers.length === 0) return;
          NodeChildProcess.execFileSync(bin, [
            "rm",
            "--force",
            ...containers.flatMap((container) => [container.id, `${container.name}-proxy`]),
          ]);
        } catch {
          // best-effort cleanup; ignore errors
        }
      },
    });
  }),
);

const parseImageTag = (tag: string) => {
  const index = tag.lastIndexOf(":");
  return index === -1 ? { name: tag } : { name: tag.slice(0, index), suffix: tag.slice(index + 1) };
};
