/**
 * Typechecks the cloudflare-bundler package's main, test, and fixture tsconfigs.
 */

import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function typecheck(configPath: string) {
  console.time(`typecheck ${configPath}`);
  await $`tsc --noEmit -p ${path.join(root, configPath)}`;
  console.timeEnd(`typecheck ${configPath}`);
}

const root = path.join(__dirname, "..");
const patterns = [
  "packages/cloudflare-bundler/tsconfig.json",
  "packages/cloudflare-bundler/test/tsconfig.json",
  "packages/cloudflare-bundler/test/fixtures/**/tsconfig.json",
];

const start = Date.now();
const configPaths: Array<string> = [];

for (const pattern of patterns) {
  for await (const name of fs.glob(pattern, {
    cwd: root,
    exclude: ["**/node_modules/**", "**/dist/**"],
  })) {
    configPaths.push(name);
  }
}

console.log(`Discovered ${configPaths.length} tsconfigs in ${Date.now() - start}ms`);
await Promise.all(configPaths.map(typecheck));
console.log(`Typecheck succeeded in ${Date.now() - start}ms`);
