import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(fixtureDir, "dist");
const manifestPath = path.join(distDir, "__distilled-build.json");

test("an assets-only SPA build removes a stale distilled build manifest", () => {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    manifestPath,
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

  const result = spawnSync("bun", ["vite", "build"], {
    cwd: fixtureDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`vite build failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }

  expect(fs.existsSync(path.join(distDir, "client", "index.html"))).toBe(true);
  expect(fs.existsSync(manifestPath)).toBe(false);
}, 120_000);
