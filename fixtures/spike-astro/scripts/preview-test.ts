/**
 * Spike part 1b: boot the built output in miniflare (production-parity check,
 * same engine the e2e harness uses for `preview`). Modules read from
 * dist/server, assets from dist/client, ASSETS binding named like production.
 */
import { createMiniflare } from "@distilled.cloud/test-utils/miniflare";
import { moduleTypeFromExtension } from "@distilled.cloud/test-utils/miniflare-module";
import * as fs from "node:fs";
import * as path from "node:path";
import { root, SPIKE_VALUE } from "./config.ts";

const serverDir = path.join(root, "dist/server");
const clientDir = path.join(root, "dist/client");

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : [p];
  });

const files = walk(serverDir).map((f) => path.relative(serverDir, f));
// astro names the ssr entry chunk `entry.mjs` (build.serverEntry); the other
// top-level chunk is `virtual_astro_middleware.mjs` (imported by the entry).
const entry =
  files.find((f) => f === "entry.mjs") ??
  files.find((f) => !f.includes("/") && f.endsWith(".mjs"));
if (!entry) throw new Error(`no top-level .mjs entry in dist/server: ${JSON.stringify(files)}`);

const modules = [entry, ...files.filter((f) => f !== entry)].flatMap((name) => {
  const type = moduleTypeFromExtension(path.extname(name));
  if (type === "SourceMap") return [];
  const raw = fs.readFileSync(path.join(serverDir, name));
  return [
    type === "ESModule" || type === "CommonJS" || type === "Text"
      ? { type, path: name, contents: raw.toString("utf8") }
      : { type, path: name, contents: raw },
  ] as any;
});
console.log(`entry: ${entry}; ${modules.length} modules`);

await using miniflare = await createMiniflare({
  compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { SPIKE_VALUE },
  modules,
  assets: {
    directory: clientDir,
    binding: "ASSETS",
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false },
    assetConfig: { html_handling: "auto-trailing-slash", not_found_handling: "none" },
  },
});

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
};

const home = await miniflare.fetch("/");
const homeText = await home.text();
check(
  "on-demand SSR page",
  home.status === 200 && homeText.includes("on-demand"),
  `status=${home.status}`,
);

const api = await miniflare.fetch("/api/hello");
const apiText = await api.text();
let apiJson: any = null;
try {
  apiJson = JSON.parse(apiText);
} catch {
  /* not json */
}
check(
  "API route reads binding",
  api.status === 200 && apiJson?.value === SPIKE_VALUE,
  `status=${api.status} body=${apiText.slice(0, 200)}`,
);

const about = await miniflare.fetch("/about/");
const aboutText = await about.text();
check(
  "prerendered page from assets",
  about.status === 200 && aboutText.includes("prerendered"),
  `status=${about.status}`,
);

const missing = await miniflare.fetch("/definitely-not-a-route");
check("404 via ASSETS fallback", missing.status === 404, `status=${missing.status}`);
await missing.arrayBuffer();

const robots = await miniflare.fetch("/robots.txt");
check("static asset", robots.status === 200, `status=${robots.status}`);
await robots.arrayBuffer();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
