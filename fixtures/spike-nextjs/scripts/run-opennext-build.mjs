// Programmatic @opennextjs/cloudflare build — NO wrangler binary, NO wrangler.json.
//
// This script is the "disposable child process" from the package design: the
// upstream pipeline mutates cwd-coupled module state, spawns `next build`, and
// can process.exit(1), so a real integration runs this exact orchestration in a
// child of its own runner module. Here we run it as its own `node` process.
//
// Instead of importing `compileConfig`/`getNormalizedOptions` from
// `dist/cli/commands/utils/utils.js` (which imports `unstable_readConfig` from
// "wrangler" at module scope), we reimplement those two thin wrappers over
// `@opennextjs/aws` exports so that NOTHING on this path ever imports wrangler.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appDir = path.resolve(import.meta.dirname, "..");
process.chdir(appDir); // upstream reads process.cwd() at module scope

const require = createRequire(path.join(appDir, "package.json"));
// The exports map doesn't expose "./package.json"; resolve the "." entry
// (dist/api/index.js) and walk up to the package root.
const cfApiIndex = require.resolve("@opennextjs/cloudflare");
const cfRoot = path.resolve(path.dirname(cfApiIndex), "..", "..");
const cfRequire = createRequire(path.join(cfRoot, "package.json"));

/** Import a file from the @opennextjs/cloudflare dist (bypasses the exports map). */
const importCf = (p) => import(pathToFileURL(path.join(cfRoot, p)).href);
/** Import a subpath of @opennextjs/aws resolved from the cloudflare package. */
const importAws = (p) => import(pathToFileURL(cfRequire.resolve(`@opennextjs/aws/${p}`)).href);

const { compileOpenNextConfig } = await importAws("build/compileConfig.js");
const { normalizeOptions } = await importAws("build/helper.js");
const { default: logger } = await importAws("logger.js");
const { ensureCloudflareConfig } = await importCf("dist/cli/build/utils/ensure-cf-config.js");
const { build } = await importCf("dist/cli/build/build.js");

// --- compileConfig equivalent (utils.ts:58) without the TTY/prompt coupling ---
const configPath = path.join(appDir, "open-next.config.ts");
const { config, buildDir } = await compileOpenNextConfig(configPath, { compileEdge: true });
ensureCloudflareConfig(config);

// --- getNormalizedOptions equivalent (utils.ts:118) ---
const openNextDistDir = path.dirname(cfRequire.resolve("@opennextjs/aws/index.js"));
const options = normalizeOptions(config, openNextDistDir, buildDir);
logger.setLevel(options.debug ? "debug" : "info");

// --- the minimal in-memory stand-in for wrangler's Unstable_Config ---
// The build pipeline reads exactly two fields (build.ts:57-70 warning;
// compile-init.ts:33 __ASSETS_RUN_WORKER_FIRST__ define).
const wranglerConfig = {
  compatibility_date: "2026-05-12",
  assets: { run_worker_first: true },
};

/** @type {import("@opennextjs/cloudflare/dist/cli/project-options.js").ProjectOptions} */
const projectOptions = {
  sourceDir: appDir,
  skipNextBuild: process.argv.includes("--skipNextBuild"),
  skipWranglerConfigCheck: true,
  minify: false,
};

await build(options, config, projectOptions, wranglerConfig, false);
console.log("[spike] OpenNext build finished OK");
