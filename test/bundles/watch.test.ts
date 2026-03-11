/**
 * Tests for watch mode (incremental rebuilds).
 *
 * These tests verify that `Bundle.watch` returns a Stream that:
 * 1. Emits Result.succeed(BundleResult) for successful builds
 * 2. Emits Result.fail(BuildError) for transient build errors (syntax errors)
 * 3. Recovers after a syntax error is fixed
 *
 * Each test copies the fixture to a temp directory so files can be modified
 * safely. Only distilled-bundler is tested — wrangler doesn't expose a
 * watch stream API.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as fs from "node:fs/promises";
import { Bundle, BundleLive, type BundleOptions } from "../../src/bundle.js";
import { fixtureDir } from "../harness/fixture.js";

const layers = Layer.provideMerge(BundleLive, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

const copyRecursive = Effect.fn(function* (
  source: string,
  destination: string,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(source);
  yield* Effect.forEach(
    entries,
    (entry) => {
      const srcPath = path.join(source, entry);
      const destPath = path.join(destination, entry);
      if (entry === ".wrangler" || entry === "node_modules") return Effect.void;
      return Effect.all(
        [fs.makeDirectory(path.dirname(destPath), { recursive: true }), fs.stat(srcPath)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(([_, stat]) => {
          if (stat.type === "Directory") {
            return copyRecursive(srcPath, destPath);
          }
          return fs.copyFile(srcPath, destPath);
        }),
      );
    },
    { concurrency: "unbounded", discard: true },
  );
});

const copyFixture = Effect.fn(function* (fixtureName: string) {
  const path = yield* Path.Path;
  const source = fixtureDir(fixtureName);
  const destination = yield* makeTempDirectory(`watch-test-${fixtureName}-`);
  yield* copyRecursive(source, destination);
  return {
    projectRoot: destination,
    entryPoint: path.join(destination, "src", "index.ts"),
  };
});

const makeTempDirectory = Effect.fn(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix });
});

layer(layers)("watch", (it) => {
  it.effect("emits initial build result", () =>
    Effect.gen(function* () {
      const fixture = yield* copyFixture("watch-basic");
      const outdir = yield* makeTempDirectory("watch-out-");

      const bundle = yield* Bundle;

      const options: BundleOptions = {
        main: fixture.entryPoint,
        projectRoot: fixture.projectRoot,
        outputDir: outdir,
        compatibilityDate: "2025-07-01",
      };

      // Open a scope so we can dispose the watcher
      const pubsub = yield* Stream.toPubSub(bundle.watch(options), { capacity: "unbounded" });
      const subscription = yield* PubSub.subscribe(pubsub);

      // First pull should yield the initial build
      const first = yield* PubSub.take(subscription);
      expect(Result.isSuccess(first)).toBe(true);

      const result = Result.getOrThrow(first);
      expect(result.main).toBeTruthy();
      expect(result.type).toBe("esm");

      // Verify the output file exists and has expected content
      const code = yield* Effect.promise(() => fs.readFile(result.main, "utf-8"));
      expect(code).toContain("v1");
    }),
  );

  it.effect("rebuilds when a source file changes", () =>
    Effect.gen(function* () {
      const fixture = yield* copyFixture("watch-basic");
      const outdir = yield* makeTempDirectory("watch-out-");

      const bundle = yield* Bundle;

      const options: BundleOptions = {
        main: fixture.entryPoint,
        projectRoot: fixture.projectRoot,
        outputDir: outdir,
        compatibilityDate: "2025-07-01",
      };

      const pubsub = yield* Stream.toPubSub(bundle.watch(options), { capacity: "unbounded" });
      const subscription = yield* PubSub.subscribe(pubsub);

      // Initial build
      const first = yield* PubSub.take(subscription);
      expect(Result.isSuccess(first)).toBe(true);

      // Modify the source file
      yield* Effect.promise(() =>
        fs.writeFile(
          fixture.entryPoint,
          `export default {
  async fetch(request: Request) {
    return new Response("v2");
  },
};
`,
        ),
      );

      // Small delay to let the filesystem event propagate
      yield* Effect.sleep("500 millis");

      // Pull the rebuild result
      const second = yield* PubSub.take(subscription);
      expect(Result.isSuccess(second)).toBe(true);

      const result = Result.getOrThrow(second);
      const code = yield* Effect.promise(() => fs.readFile(result.main, "utf-8"));
      expect(code).toContain("v2");
      expect(code).not.toContain("v1");
    }),
  );

  it.effect("emits Result.fail for syntax errors and recovers", () =>
    Effect.gen(function* () {
      const fixture = yield* copyFixture("watch-basic");
      const outdir = yield* makeTempDirectory("watch-out-");

      const bundle = yield* Bundle;

      const options: BundleOptions = {
        main: fixture.entryPoint,
        projectRoot: fixture.projectRoot,
        outputDir: outdir,
        compatibilityDate: "2025-07-01",
      };

      const pubsub = yield* Stream.toPubSub(bundle.watch(options), { capacity: "unbounded" });
      const subscription = yield* PubSub.subscribe(pubsub);

      // Initial build should succeed
      const first = yield* PubSub.take(subscription);
      expect(Result.isSuccess(first)).toBe(true);

      // Introduce a syntax error
      yield* Effect.promise(() =>
        fs.writeFile(
          fixture.entryPoint,
          `export default {
  async fetch(request: Request) {
    return new Response("broken"
  },
};
`,
        ),
      );

      yield* Effect.sleep("500 millis");

      // Pull should yield a failure result (stream continues)
      const errResult = yield* PubSub.take(subscription);
      expect(Result.isFailure(errResult)).toBe(true);

      // Fix the syntax error
      yield* Effect.promise(() =>
        fs.writeFile(
          fixture.entryPoint,
          `export default {
  async fetch(request: Request) {
    return new Response("v3-fixed");
  },
};
`,
        ),
      );

      yield* Effect.sleep("500 millis");

      // Pull should yield a success again — stream recovered
      const recovered = yield* PubSub.take(subscription);
      expect(Result.isSuccess(recovered)).toBe(true);

      const result = Result.getOrThrow(recovered);
      const code = yield* Effect.promise(() => fs.readFile(result.main, "utf-8"));
      expect(code).toContain("v3-fixed");
    }),
  );
});
