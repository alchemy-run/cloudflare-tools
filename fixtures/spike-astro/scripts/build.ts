/**
 * Spike part 1: programmatic astro build() with the forked integration.
 * Verifies the emitted layout: dist/server entry + dist/client, no wrangler.json.
 */
import { build } from "astro";
import * as fs from "node:fs";
import * as path from "node:path";
import { inlineConfig, root } from "./config.ts";

await build(inlineConfig());

const dist = path.join(root, "dist");
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });

const files = walk(dist).map((f) => path.relative(dist, f));
console.log(`\ndist contents (${files.length} files):`);
for (const f of files) console.log(`  ${f}`);

const failures: string[] = [];
const serverEntries = files.filter((f) => f.startsWith("server/") && f.endsWith(".mjs") && !f.includes("/chunks/") && !f.includes("/pages/"));
if (serverEntries.length === 0) failures.push("no server entry .mjs found under dist/server/");
if (!files.some((f) => f === "client/about/index.html"))
  failures.push("prerendered client/about/index.html missing");
if (!files.some((f) => f === "client/robots.txt")) failures.push("client/robots.txt missing");
if (files.some((f) => f.includes("wrangler.json")))
  failures.push("a wrangler.json was emitted — wrangler decoupling failed");
if (files.some((f) => f.startsWith("server/.prerender/")))
  failures.push("prerender build directory was not cleaned up");

console.log(`\nserver entry candidates: ${JSON.stringify(serverEntries)}`);
if (failures.length) {
  console.error(`\nBUILD CHECK FAILURES:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nbuild layout OK (no wrangler.json anywhere)");
