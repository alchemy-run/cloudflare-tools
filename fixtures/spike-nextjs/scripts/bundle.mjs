// The "final bundle pass" wrangler normally performs at deploy time:
// .open-next/worker.js (+ its deliberately-unresolved relative imports) is
// bundled into a self-contained ESM module set under dist-worker/.
//
// - the dynamic import of server-functions/default/handler.mjs stays a lazy
//   chunk (splitting: true)
// - .wasm/.bin files are copied out as separate files (loader: "copy") and
//   later registered as CompiledWasm/Data modules with cloudflare-runtime
// - cloudflare:* stays external (provided by workerd)
// - node:* stays external (provided by nodejs_compat)
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");
const openNextDir = path.join(appDir, ".open-next");
const outDir = path.join(appDir, "dist-worker");

fs.rmSync(outDir, { recursive: true, force: true });

/**
 * OpenNext's `setWranglerExternal` esbuild plugin leaves `.wasm`/`.bin`
 * imports in handler.mjs as ABSOLUTE paths (optionally with a `?module`
 * suffix) "for wrangler to bundle". Strip the suffix and route them through
 * esbuild's copy loader so they become relative file imports we can register
 * as CompiledWasm/Data modules.
 */
const wranglerExternalsPlugin = {
  name: "spike-wrangler-externals",
  setup(build) {
    build.onResolve({ filter: /\.(wasm|bin)(\?module)?$/ }, (args) => {
      const clean = args.path.replace(/\?module$/, "");
      return {
        path: path.isAbsolute(clean) ? clean : path.resolve(args.resolveDir, clean),
      };
    });
  },
};

const result = await esbuild.build({
  plugins: [wranglerExternalsPlugin],
  entryPoints: [path.join(openNextDir, "worker.js")],
  outdir: outDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  conditions: ["workerd", "worker"],
  splitting: true,
  minify: false,
  sourcemap: false,
  metafile: true,
  external: ["cloudflare:*", "node:*"],
  loader: {
    ".wasm": "copy",
    ".bin": "copy",
  },
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "[name]-[hash]",
  logLevel: "info",
  // wrangler's trick: CJS-converted code inside the bundle calls
  // require("fs") etc. for externalized node builtins; esbuild's __require
  // shim throws "Dynamic require of X is not supported" unless a real
  // `require` is in scope. workerd's nodejs_compat implements
  // node:module.createRequire, so provide one per output file.
  banner: {
    js: [
      `import { createRequire as __spike_createRequire } from "node:module";`,
      `const require = /* @__PURE__ */ __spike_createRequire(import.meta.url ?? "file:///");`,
    ].join("\n"),
  },
});

fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(result.metafile, null, 2));

// populateCache (static-assets flavor) without wrangler: the prerendered
// ISR/fetch cache entries are just copied into the assets dir
// (populate-cache.ts populateStaticAssetsIncrementalCache).
const cacheDir = path.join(openNextDir, "cache");
if (fs.existsSync(cacheDir)) {
  fs.cpSync(cacheDir, path.join(openNextDir, "assets", "cdn-cgi/_next_cache"), {
    recursive: true,
  });
  console.log("[spike] populated static-assets incremental cache (cdn-cgi/_next_cache)");
}

const files = fs.readdirSync(outDir, { recursive: true });
console.log("[spike] final bundle emitted:");
for (const f of files) {
  const full = path.join(outDir, String(f));
  if (fs.statSync(full).isFile()) {
    console.log(`  ${f} (${(fs.statSync(full).size / 1024).toFixed(1)} KiB)`);
  }
}
