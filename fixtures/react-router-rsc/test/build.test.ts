import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Production-build smoke test for the distilled build manifest. Builds the
// fixture and asserts the emitted `__distilled-build.json` describes a complete,
// self-contained worker module set — the contract a deployer consumes.
const fixtureDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(fixtureDir, "dist");

type Manifest = {
  version: number;
  worker: { main: string; modules: Array<string>; compatibilityFlags?: Array<string> };
  assets?: { directory: string };
};
let manifest: Manifest;

beforeAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
  const result = spawnSync("bun", ["vite", "build"], { cwd: fixtureDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`vite build failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  manifest = JSON.parse(fs.readFileSync(path.join(distDir, "__distilled-build.json"), "utf8"));
}, 120_000);

test("emits a build manifest describing the worker entry and assets", () => {
  expect(manifest.version).toBe(1);
  expect(manifest.worker.main).toBeTruthy();
  expect(manifest.worker.modules).toContain(manifest.worker.main);
  expect(manifest.worker.modules.length).toBeGreaterThan(0);
  expect(manifest.assets?.directory).toBe("client");
  expect(manifest.worker.compatibilityFlags).toContain("nodejs_compat");
});

test("folds the worker-loaded ssr output into the worker module set", () => {
  // The single-worker RSC topology loads the `ssr` env at runtime via
  // loadModule (`import("../../ssr/...")`), so its output must ship as part of
  // the same worker — both the entry (`server/`) and child (`ssr/`) outputs.
  expect(manifest.worker.modules.some((module) => module.startsWith("server/"))).toBe(true);
  expect(manifest.worker.modules.some((module) => module.startsWith("ssr/"))).toBe(true);
  expect(manifest.worker.modules).toContain("ssr/worker-ssr.js");
});

test("worker module set is self-contained (every relative import resolves)", () => {
  const moduleSet = new Set(manifest.worker.modules);
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const unresolved: Array<string> = [];
  for (const module of manifest.worker.modules) {
    for (const imported of transpiler.scanImports(
      fs.readFileSync(path.join(distDir, module), "utf8"),
    )) {
      if (!imported.path.startsWith(".")) continue;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(module), imported.path),
      );
      if (!moduleSet.has(resolved)) unresolved.push(`${module} -> ${imported.path}`);
    }
  }
  expect(unresolved).toEqual([]);
});

test("client assets are not part of the worker module set", () => {
  expect(manifest.worker.modules.some((module) => module.startsWith("client/"))).toBe(false);
});
