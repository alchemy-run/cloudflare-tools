/**
 * Typechecks every `tsconfig.json` under workspace packages (and nested test/fixtures).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

async function typecheck(configPath: string) {
  console.time(`typecheck ${configPath}`);
  await $`tsc --noEmit -p ${configPath}`;
  console.timeEnd(`typecheck ${configPath}`);
}

const root = path.join(__dirname, "..");
const patterns = [
  "packages/*/tsconfig.json",
  "packages/*/test/tsconfig.json",
  "packages/*/test/fixtures/**/tsconfig.json",
];

const promises: Array<Promise<void>> = [];
const start = Date.now();

for (const pattern of patterns) {
  for await (const name of fs.glob(pattern, {
    cwd: root,
    exclude: ["**/node_modules/**", "**/dist/**"],
  })) {
    promises.push(typecheck(name));
  }
}

console.log(`Discovered ${promises.length} tsconfigs in ${Date.now() - start}ms`);
await Promise.all(promises);
console.log(`Typecheck succeeded in ${Date.now() - start}ms`);
