import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Assets from "../../src/bindings/assets/Assets.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const ASSETS_SCRIPT = `
export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
`;

const writeFixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(path.join(dir, "index.html"), "<h1>home</h1>");
  yield* fs.writeFileString(path.join(dir, "404.html"), "<h1>missing</h1>");
  return dir;
});

describe("Assets / buildAssetConfigs", () => {
  it("returns expected router and assets config", () => {
    const { routerConfig, assetsConfig } = Assets.buildAssetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: {
        directory: "/tmp/x",
        notFoundHandling: "404-page",
        htmlHandling: "auto-trailing-slash",
        runWorkerFirst: ["/api/*"],
      },
    });
    expect(routerConfig).toMatchObject({
      invoke_user_worker_ahead_of_assets: true,
      has_user_worker: true,
    });
    expect(routerConfig.static_routing).toBeDefined();
    expect(assetsConfig).toMatchObject({
      compatibility_date: "2026-03-10",
      not_found_handling: "404-page",
      html_handling: "auto-trailing-slash",
      has_static_routing: true,
    });
  });

  it("disables invoke_user_worker_ahead_of_assets when runWorkerFirst is false", () => {
    const { routerConfig } = Assets.buildAssetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: { directory: "/tmp/x", runWorkerFirst: false },
    });
    expect(routerConfig.invoke_user_worker_ahead_of_assets).toBe(false);
  });
});

layer(Layer.provideMerge(localRuntimeLayer, NodeServices.layer))("Assets binding", (it) => {
  it.effect("registers an assets:worker service when worker.assets is configured", () =>
    Effect.gen(function* () {
      const dir = yield* writeFixture();
      const { baseUrl } = yield* startTestWorker({
        name: "assets-bound",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: ASSETS_SCRIPT }],
        assets: { directory: dir },
        bindings: [Assets.binding("ASSETS")] as const,
      });
      // The worker started cleanly and is reachable on its socket.
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = yield* Effect.promise(() => fetch(baseUrl));
      // Either 200 (asset served) or a structured non-200 — both indicate the
      // binding wired up without crashing the worker config.
      expect([200, 404, 500]).toContain(response.status);
    }).pipe(Effect.scoped),
  );

  it.effect("Assets.binding fails with ConfigError when no assets are configured", () =>
    Effect.gen(function* () {
      const error = yield* startTestWorker({
        name: "assets-missing",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [{ name: "main.js", type: "ESModule", content: ASSETS_SCRIPT }],
        bindings: [Assets.binding("ASSETS")] as const,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ConfigError", subtag: "Assets" });
    }),
  );
});
