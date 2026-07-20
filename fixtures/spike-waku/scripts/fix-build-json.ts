/**
 * Spike stand-in for the planned framework-core `readServerModulesFromDisk`:
 * rebuilds `dist/build.json`'s serverModules from the files actually on disk
 * under dist/server. This fixes two collector gaps found by the spike:
 *
 * 1. `server/__waku_build_metadata.js` is written during `buildApp` hooks
 *    (waku buildMetadataPlugin + handler.ts) AFTER writeBundle, and imported
 *    via a relative path rewritten in renderChunk — the in-memory collector
 *    never sees it, so the worker fails to boot ("No such module").
 * 2. waku's prune step stubs static-only chunks on disk after writeBundle;
 *    the in-memory copies are the unpruned originals (functionally fine but
 *    stale/larger).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const distDir = path.join(root, "dist");
const buildJsonPath = path.join(distDir, "build.json");

const build = JSON.parse(fs.readFileSync(buildJsonPath, "utf8"));

const ENTRY = "server/index.js";

const walk = (dir: string): Array<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });

const isText = (file: string) => /\.(m?js|cjs|json|txt|html|sql|map)$/.test(file);

const serverDir = path.join(distDir, "server");
const files = walk(serverDir).sort();

const serverModules = files
  .map((file) => {
    const name = path.relative(distDir, file);
    const content = isText(file)
      ? fs.readFileSync(file, "utf8")
      : fs.readFileSync(file);
    return {
      name,
      content: typeof content === "string" ? content : { type: "Buffer", data: [...content] },
      hash: createHash("sha256").update(content).digest("hex"),
    };
  })
  .sort((a, b) => {
    if (a.name === ENTRY) return -1;
    if (b.name === ENTRY) return 1;
    return a.name.localeCompare(b.name);
  });

if (serverModules[0]?.name !== ENTRY) {
  throw new Error(`entry ${ENTRY} not found on disk`);
}

build.serverModules = serverModules;
fs.writeFileSync(buildJsonPath, JSON.stringify(build, null, 2));
console.log(
  "rewrote serverModules from disk:",
  serverModules.map((m) => m.name),
);
