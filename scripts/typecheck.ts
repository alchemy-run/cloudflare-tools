/**
 * We have multiple tsconfigs, so this script typechecks all of them in parallel.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

async function typecheck(name: string) {
  console.time(`typecheck ${name}`);
  await $`tsc --noEmit -p ${name}`;
  console.timeEnd(`typecheck ${name}`);
}

const promises: Array<Promise<void>> = [];
const start = Date.now();
for await (const name of fs.glob("**/tsconfig.json", {
  cwd: path.join(__dirname, ".."),
  exclude: ["node_modules", "dist", ".wrangler", "workers-sdk"],
})) {
  promises.push(typecheck(name));
}
console.log(`Discovered ${promises.length} tsconfigs in ${Date.now() - start}ms`);
await Promise.all(promises);
console.log(`Typecheck succeeded in ${Date.now() - start}ms`);
