/**
 * We have multiple tsconfigs, so this script typechecks all of them in parallel.
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

const promises: Array<Promise<void>> = [];
const start = Date.now();
await remove(path.join(__dirname, "..", "dist"));
for await (const name of fs.glob("**/tsconfig.tsbuildinfo", {
  cwd: path.join(__dirname, ".."),
  exclude: ["node_modules", "dist", ".wrangler", "workers-sdk"],
})) {
  promises.push(remove(name));
}

await Promise.all(promises);
console.log(`Removed ${count} files in ${Date.now() - start}ms`);
