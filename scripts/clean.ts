/**
 * Removes build outputs: each workspace package's `dist/` and TypeScript incremental caches.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

let count = 0;

async function remove(filePath: string) {
  count++;
  console.time(`remove ${filePath}`);
  await fs.rm(filePath, { recursive: true, force: true });
  console.timeEnd(`remove ${filePath}`);
}

const root = path.join(__dirname, "..");
const start = Date.now();

const distRemovals: Array<Promise<void>> = [];
distRemovals.push(remove(path.join(root, "dist")));

const packagesDir = path.join(root, "packages");
try {
  for (const name of await fs.readdir(packagesDir)) {
    distRemovals.push(remove(path.join(packagesDir, name, "dist")));
  }
} catch {
  // no packages/ yet
}

await Promise.all(distRemovals);

const cacheRemovals: Array<Promise<void>> = [];
for await (const name of fs.glob("packages/**/tsconfig.tsbuildinfo", {
  cwd: root,
  exclude: ["**/node_modules/**", "**/dist/**"],
})) {
  cacheRemovals.push(remove(path.join(root, name)));
}

cacheRemovals.push(remove(path.join(root, "tsconfig.tsbuildinfo")));

await Promise.all(cacheRemovals);
console.log(`Removed ${count} paths in ${Date.now() - start}ms`);
