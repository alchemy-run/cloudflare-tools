import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as DevRegistry from "../../src/dev-registry/DevRegistry.ts";

const inFreshRegistry = <A, E>(
  self: (registryPath: string) => Effect.Effect<A, E, DevRegistry.DevRegistry>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const registryPath = yield* fs.makeTempDirectoryScoped();
    process.env.MINIFLARE_REGISTRY_PATH = registryPath;
    return yield* self(registryPath).pipe(
      Effect.provide(Layer.provide(DevRegistry.DevRegistryLive, NodeServices.layer)),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DevRegistry", () => {
  it.effect("register writes a worker definition and getRegistry returns it", () =>
    inFreshRegistry((registryPath) =>
      Effect.gen(function* () {
        const definitionPath = NodePath.join(registryPath, "test-worker");
        yield* Effect.gen(function* () {
          const registry = yield* DevRegistry.DevRegistry;
          yield* registry.register({
            "test-worker": {
              debugPortAddress: "127.0.0.1:12345",
              defaultEntrypointService: "user",
              userWorkerService: "user",
            },
          });
          expect(NodeFs.existsSync(definitionPath)).toBe(true);
          const found = yield* registry.getRegistry();
          expect(found["test-worker"]).toMatchObject({
            debugPortAddress: "127.0.0.1:12345",
            defaultEntrypointService: "user",
            userWorkerService: "user",
          });
        }).pipe(Effect.scoped);
        // After scope close, the file should have been removed.
        expect(NodeFs.existsSync(definitionPath)).toBe(false);
      }),
    ),
  );

  it.effect("getRegistry returns an empty object when the directory is empty", () =>
    inFreshRegistry(() =>
      Effect.gen(function* () {
        const registry = yield* DevRegistry.DevRegistry;
        expect(yield* registry.getRegistry()).toEqual({});
      }),
    ),
  );

  it.effect("getRegistry skips definitions older than the staleness threshold", () =>
    inFreshRegistry((registryPath) =>
      Effect.gen(function* () {
        const stalePath = NodePath.join(registryPath, "stale");
        NodeFs.writeFileSync(stalePath, JSON.stringify({}));
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        NodeFs.utimesSync(stalePath, tenMinAgo, tenMinAgo);
        const registry = yield* DevRegistry.DevRegistry;
        expect(yield* registry.getRegistry()).toEqual({});
      }),
    ),
  );
});
