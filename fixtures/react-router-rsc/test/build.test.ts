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
  workers: {
    app: {
      main: string;
      modules: Array<{ path: string; type: string }>;
      compatibilityDate?: string;
      compatibilityFlags?: Array<string>;
    };
  };
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
  const worker = manifest.workers.app;

  expect(manifest.version).toBe(2);
  // The framework also emits `server/index.js`; the main entry must be the
  // distilled worker-entry wrapper captured from the real write pass.
  expect(worker.main).toBe("server/entry.worker.js");
  expect(worker.modules).toContainEqual({ path: worker.main, type: "esm" });
  expect(worker.modules.length).toBeGreaterThan(0);
  expect(worker.modules.every((module) => module.path && module.type)).toBe(true);
  expect(manifest.assets?.directory).toBe("client");
  expect(worker.compatibilityDate).toBe("2026-03-10");
  expect(worker.compatibilityFlags).toContain("nodejs_compat");
});

test("folds the worker-loaded ssr output into the worker module set", () => {
  const modulePaths = manifest.workers.app.modules.map((module) => module.path);

  // The single-worker RSC topology loads the `ssr` env at runtime via
  // loadModule (`import("../../ssr/...")`), so its output must ship as part of
  // the same worker — both the entry (`server/`) and child (`ssr/`) outputs.
  expect(modulePaths.some((module) => module.startsWith("server/"))).toBe(true);
  expect(modulePaths.some((module) => module.startsWith("ssr/"))).toBe(true);
  expect(modulePaths).toContain("ssr/worker-ssr.js");
});

test("worker module entries are sorted and unique", () => {
  const modulePaths = manifest.workers.app.modules.map((module) => module.path);

  expect(modulePaths).toEqual([...modulePaths].sort((a, b) => a.localeCompare(b)));
  expect(new Set(modulePaths).size).toBe(modulePaths.length);
});

test("worker module set is self-contained (every relative import resolves)", () => {
  const moduleSet = new Set(manifest.workers.app.modules.map((module) => module.path));
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const unresolved: Array<string> = [];
  for (const module of manifest.workers.app.modules) {
    if (module.type !== "esm") continue;
    for (const imported of transpiler.scanImports(
      fs.readFileSync(path.join(distDir, module.path), "utf8"),
    )) {
      if (!imported.path.startsWith(".")) continue;
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(module.path), imported.path),
      );
      if (!moduleSet.has(resolved)) unresolved.push(`${module.path} -> ${imported.path}`);
    }
  }
  expect(unresolved).toEqual([]);
});

test("client assets are not part of the worker module set", () => {
  expect(manifest.workers.app.modules.some((module) => module.path.startsWith("client/"))).toBe(
    false,
  );
});

test("a custom RSC outDir split removes stale manifest and emits no broken graph", () => {
  const customDistDir = path.join(fixtureDir, "dist-custom");
  const customManifestPath = path.join(customDistDir, "__distilled-build.json");
  try {
    fs.rmSync(customDistDir, { recursive: true, force: true });
    fs.mkdirSync(customDistDir, { recursive: true });
    fs.writeFileSync(
      customManifestPath,
      `${JSON.stringify({
        version: 2,
        workers: {
          app: {
            main: "server/stale.js",
            modules: [{ path: "server/stale.js", type: "esm" }],
          },
        },
      })}\n`,
    );

    const result = spawnSync("bun", ["vite", "build", "--outDir", "dist-custom"], {
      cwd: fixtureDir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`vite build failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    }

    expect(result.stderr).toContain(`skipping __distilled-build.json`);
    expect(fs.existsSync(customManifestPath)).toBe(false);
  } finally {
    fs.rmSync(customDistDir, { recursive: true, force: true });
  }
}, 120_000);

// Must run last: it triggers a second build that rewrites `dist`.
test("a rebuild drops stale worker files left in the output", () => {
  const stale = path.join(distDir, "server", "STALE_REVIEW_MARKER.js");
  fs.writeFileSync(stale, "// stale\n");
  const result = spawnSync("bun", ["vite", "build"], { cwd: fixtureDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`vite build failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  const rebuilt: Manifest = JSON.parse(
    fs.readFileSync(path.join(distDir, "__distilled-build.json"), "utf8"),
  );
  expect(rebuilt.workers.app.modules.map((module) => module.path)).not.toContain(
    "server/STALE_REVIEW_MARKER.js",
  );
  expect(fs.existsSync(stale)).toBe(false);
}, 120_000);
