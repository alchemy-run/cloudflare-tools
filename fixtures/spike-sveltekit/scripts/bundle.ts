/**
 * Re-bundle the node22-flavored SvelteKit `_worker.js` output for workerd using
 * rolldown + @distilled.cloud/cloudflare-rolldown-plugin (this replaces the
 * bundling `wrangler deploy` performs for the upstream adapter).
 */
import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import path from "node:path";
import { rolldown } from "rolldown";

const root = path.resolve(import.meta.dirname, "..");
const input = path.join(root, ".svelte-kit/cloudflare/_worker.js");
const outDir = path.join(root, "dist/worker");

const build = await rolldown({
  cwd: root,
  input,
  plugins: cloudflare({
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    exports: ["default"],
  }),
});

const { output } = await build.write({
  dir: outDir,
  format: "esm",
  entryFileNames: "index.js",
  chunkFileNames: "chunks/[name].js",
  sourcemap: false,
});
await build.close();

for (const chunk of output) {
  console.log(
    `[spike] emitted ${chunk.fileName} (${chunk.type === "chunk" ? `${chunk.code.length} bytes${chunk.isEntry ? ", entry" : ""}` : "asset"})`,
  );
}
