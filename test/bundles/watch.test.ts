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
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Bundle, type CloudflareOptions } from "../../src/bundle.js";
import { EsbuildBundleLive } from "../../src/esbuild/index.js";
import { fixtureDir } from "../harness/fixture.js";

const layers = Layer.provideMerge(EsbuildBundleLive, Layer.mergeAll(NodeFileSystem.layer, NodePath.layer));

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

const makeWatchBundle = Effect.fn(function* (options: CloudflareOptions) {
  const bundle = yield* Bundle;
  const pubsub = yield* Stream.toPubSub(bundle.watch(options), { capacity: "unbounded" });
  const subscription = yield* PubSub.subscribe(pubsub);
  return {
    next: PubSub.take(subscription),
  };
});

layer(layers)("watch", (it) => {
  it.effect("emits initial build result", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const fixture = yield* copyFixture("watch-basic");
      const outdir = yield* makeTempDirectory("watch-out-");
      const bundle = yield* makeWatchBundle({
        main: fixture.entryPoint,
        projectRoot: fixture.projectRoot,
        outputDir: outdir,
        compatibilityDate: "2025-07-01",
      });

      // First pull should yield the initial build
      const first = yield* bundle.next;
      expect(Result.isSuccess(first)).toBe(true);

      const result = Result.getOrThrow(first);
      expect(result.main).toBeTruthy();
      expect(result.type).toBe("esm");

      // Verify the output file exists and has expected content
      const code = yield* fs.readFileString(result.main);
      expect(code).toContain("v1");
    }),
  );

  it.effect("rebuilds when a source file changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const fixture = yield* copyFixture("watch-basic");
      const outdir = yield* makeTempDirectory("watch-out-");
      const bundle = yield* makeWatchBundle({
        main: fixture.entryPoint,
        projectRoot: fixture.projectRoot,
        outputDir: outdir,
        compatibilityDate: "2025-07-01",
      });

      // Initial build
      const first = yield* bundle.next;
      expect(Result.isSuccess(first)).toBe(true);

      // Modify the source file
      yield* fs.writeFileString(
        fixture.entryPoint,
        `export default {
  async fetch(request: Request) {
    return new Response("v2");
  },
};
`,
      );

      // Pull the rebuild result
      const second = yield* bundle.next;
      expect(Result.isSuccess(second)).toBe(true);

      const result = Result.getOrThrow(second);
      const code = yield* fs.readFileString(result.main);
      expect(code).toContain("v2");
      expect(code).not.toContain("v1");
    }),
  );

  it.effect("emits Result.fail for syntax errors and recovers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const fixture = yield* copyFixture("watch-basic");
      const outdir = yield* makeTempDirectory("watch-out-");
      const bundle = yield* makeWatchBundle({
        main: fixture.entryPoint,
        projectRoot: fixture.projectRoot,
        outputDir: outdir,
        compatibilityDate: "2025-07-01",
      });

      // Initial build should succeed
      const first = yield* bundle.next;
      expect(Result.isSuccess(first)).toBe(true);

      // Introduce a syntax error
      yield* fs.writeFileString(
        fixture.entryPoint,
        `export default {
  async fetch(request: Request) {
    return new Response("broken"
  },
};
`,
      );

      // Pull should yield a failure result (stream continues)
      const errResult = yield* bundle.next;
      expect(Result.isFailure(errResult)).toBe(true);

      // Fix the syntax error
      yield* fs.writeFileString(
        fixture.entryPoint,
        `export default {
  async fetch(request: Request) {
    return new Response("v3-fixed");
  },
};
`,
      );

      // Pull should yield a success again — stream recovered
      const recovered = yield* bundle.next;
      assert(Result.isSuccess(recovered));

      const code = yield* fs.readFileString(recovered.success.main);
      expect(code).toContain("v3-fixed");
    }),
  );
});
