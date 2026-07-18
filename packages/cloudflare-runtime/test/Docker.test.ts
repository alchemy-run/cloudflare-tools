import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { Docker, DockerLive, toPullRef } from "../src/Docker.ts";

const PINNED =
  "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";
const PINNED_WITHOUT_TAG =
  "cloudflare/proxy-everything@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";

describe("Docker", () => {
  describe("toPullRef", () => {
    it("drops the tag when a digest pins the image", () => {
      expect(toPullRef(PINNED)).toBe(PINNED_WITHOUT_TAG);
    });

    it("keeps tag-only refs unchanged", () => {
      expect(toPullRef("rocicorp/zero:1.8.0")).toBe("rocicorp/zero:1.8.0");
    });

    it("keeps digest-only refs unchanged", () => {
      expect(toPullRef("repo@sha256:abc")).toBe("repo@sha256:abc");
    });

    it("preserves registry ports", () => {
      expect(toPullRef("registry.example.com:5000/repo:v1@sha256:abc")).toBe(
        "registry.example.com:5000/repo@sha256:abc",
      );
    });
  });
});

/** Records every spawned argv and pretends each command exited 0 with no output. */
const spawned: Array<ReadonlyArray<string>> = [];
const SpawnerStub = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") {
      spawned.push([command.command, ...command.args]);
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  }),
);

layer(Layer.provide(DockerLive, Layer.merge(NodeServices.layer, SpawnerStub)))((it) => {
  it.effect("pull strips the tag from digest-pinned refs", () =>
    Effect.gen(function* () {
      spawned.length = 0;
      const docker = yield* Docker;
      yield* docker.pull("alchemy-test:latest", { imageUri: PINNED });
      expect(spawned).toContainEqual([
        "docker",
        "pull",
        PINNED_WITHOUT_TAG,
        "--platform",
        "linux/amd64",
      ]);
      // only the pull ref is rewritten — the local tag alias keeps the original uri
      expect(spawned).toContainEqual(["docker", "tag", PINNED, "alchemy-test:latest"]);
    }),
  );

  it.effect("pull passes refs without a digest through unchanged", () =>
    Effect.gen(function* () {
      spawned.length = 0;
      const docker = yield* Docker;
      yield* docker.pull("alchemy-test:latest", { imageUri: "rocicorp/zero:1.8.0" });
      expect(spawned).toContainEqual([
        "docker",
        "pull",
        "rocicorp/zero:1.8.0",
        "--platform",
        "linux/amd64",
      ]);
    }),
  );
});
