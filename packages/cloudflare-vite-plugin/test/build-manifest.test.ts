import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBuilder, type Plugin } from "vite";
import * as fs from "node:fs";
import path from "node:path";

const sourceFixtureDir = path.resolve(
  import.meta.dirname,
  "../../cloudflare-rolldown-plugin/test/fixtures/additional-modules",
);
const fixtureDir = path.resolve(import.meta.dirname, "../.test-tmp/additional-modules");
const distDir = path.join(fixtureDir, "dist");
const manifestPath = path.join(distDir, "__distilled-build.json");

type Manifest = {
  version: number;
  workers: {
    app: {
      main: string;
      modules: Array<{ path: string; type: string }>;
      compatibilityDate?: string;
      compatibilityFlags?: Array<string>;
    };
  };
};

const workerArtifactPlugin = {
  name: "test-worker-artifacts",
  generateBundle() {
    if (this.environment.name !== "ssr") return;
    this.emitFile({
      type: "asset",
      fileName: "diagnostic.json",
      source: JSON.stringify({ ok: true }),
    });
    this.emitFile({
      type: "asset",
      fileName: "ignored.js.map",
      source: "{}",
    });
  },
} satisfies Plugin;

describe("build manifest", () => {
  let manifest: Manifest;

  beforeAll(async () => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.cpSync(sourceFixtureDir, fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, "index.html"), '<div id="root"></div>\n');

    const builder = await createBuilder({
      root: fixtureDir,
      logLevel: "silent",
      plugins: [
        cloudflare({
          main: "./index.ts",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: ["nodejs_compat"],
        }),
        workerArtifactPlugin,
      ],
      build: {
        minify: false,
      },
    });
    await builder.buildApp();
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("records explicit module types for emitted worker modules", () => {
    const worker = manifest.workers.app;
    const modulePaths = worker.modules.map((module) => module.path);

    expect(manifest.version).toBe(2);
    expect(worker.compatibilityDate).toBe("2026-03-10");
    expect(worker.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(modulePaths).toEqual([...modulePaths].sort((a, b) => a.localeCompare(b)));
    expect(new Set(modulePaths).size).toBe(modulePaths.length);
    expect(worker.modules).toContainEqual({
      path: worker.main,
      type: "esm",
    });
    expect(worker.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/bin-example.*\.bin$/),
          type: "data",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/html-example.*\.html$/),
          type: "text",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/text-example.*\.txt$/),
          type: "text",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/sql-example.*\.sql$/),
          type: "text",
        }),
        expect.objectContaining({
          path: expect.stringMatching(/wasm-example.*\.wasm$/),
          type: "wasm",
        }),
        expect.objectContaining({
          path: "server/diagnostic.json",
          type: "json",
        }),
      ]),
    );
    expect(worker.modules.some((module) => module.path.endsWith(".map"))).toBe(false);
    expect(worker.modules.some((module) => module.type === "sourcemap")).toBe(false);
  });
});
