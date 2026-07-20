/**
 * Boot the re-bundled SvelteKit worker in @distilled.cloud/cloudflare-runtime
 * (direct workerd, no miniflare/wrangler) and assert:
 *   1. SSR route 200 + platform.env access works (Text.local binding)
 *   2. server endpoint 200 (cookie + uuid + node:crypto)
 *   3. prerendered page served from assets
 *   4. client asset served via ASSETS
 */
import * as Runtime from "@distilled.cloud/cloudflare-runtime/Runtime";
import * as RuntimeServices from "@distilled.cloud/cloudflare-runtime/RuntimeServices";
import * as Text from "@distilled.cloud/cloudflare-runtime/bindings/Text";
import * as AssetsBinding from "@distilled.cloud/cloudflare-runtime/bindings/assets/Assets";
import type { Module } from "@distilled.cloud/cloudflare-runtime/RuntimeWorker";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import fs from "node:fs";
import path from "node:path";

// remote bindings are never used in this spike; satisfy layer construction only
process.env.CLOUDFLARE_API_TOKEN ??= "spike-dummy-token";

const root = path.resolve(import.meta.dirname, "..");
const workerDir = path.join(root, "dist/worker");
const clientDir = path.join(root, ".svelte-kit/cloudflare");

const readModules = (): Array<Module> => {
  const files: Array<string> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(workerDir);
  const modules = files
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
    .map((f): Module => ({
      name: path.relative(workerDir, f),
      type: "ESModule",
      content: fs.readFileSync(f, "utf8"),
    }));
  // entry first
  modules.sort((a, b) => (a.name === "index.js" ? -1 : b.name === "index.js" ? 1 : a.name.localeCompare(b.name)));
  return modules;
};

const assertions: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => {
  assertions.push({ name, ok, detail });
  console.log(`[spike] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const program = Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const modules = readModules();
  console.log(`[spike] booting with ${modules.length} modules, entry = ${modules[0]?.name}`);

  const url = yield* runtime.start({
    name: "spike-sveltekit",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    bindings: [Text.local("SPIKE_SECRET", "s3cret-from-binding"), AssetsBinding.local("ASSETS")],
    modules,
    assets: {
      directory: clientDir,
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
      // assets router first (Workers default) — worker only sees non-asset requests
      runWorkerFirst: false,
    },
  });
  console.log(`[spike] workerd listening at ${url}`);

  const get = (p: string) => Effect.promise(() => fetch(new URL(p, url)));

  // 1. SSR route
  const home = yield* get("/");
  const homeText = yield* Effect.promise(() => home.text());
  check("ssr-status", home.status === 200, `GET / -> ${home.status}`);
  check(
    "ssr-platform-env",
    homeText.includes("secret:s3cret-from-binding"),
    homeText.includes("secret:")
      ? `rendered: ${homeText.match(/secret:[^<]*/)?.[0]}`
      : `no secret marker in body (${homeText.slice(0, 200)})`,
  );
  check("ssr-ctx", homeText.includes("ctx:yes"), `${homeText.match(/ctx:[^<]*/)?.[0]}`);
  check("ssr-devalue", homeText.includes("devalued:{n:1}"), `${homeText.match(/devalued:[^<]*/)?.[0]}`);

  // 2. endpoint
  const api = yield* get("/api/hello");
  const apiText = yield* Effect.promise(() => api.text());
  check("endpoint-status", api.status === 200, `GET /api/hello -> ${api.status}`);
  let apiJson: any = undefined;
  try {
    apiJson = JSON.parse(apiText);
  } catch {}
  check(
    "endpoint-body",
    !!apiJson &&
      typeof apiJson.uuid === "string" &&
      typeof apiJson.nodeUuid === "string" &&
      apiJson.cookie === "spike=ok" &&
      apiJson.secret === "s3cret-from-binding",
    JSON.stringify(apiJson ?? apiText.slice(0, 200)),
  );

  // 3. prerendered page (served by the assets router, worker not involved)
  const pre = yield* get("/prerendered");
  const preText = yield* Effect.promise(() => pre.text());
  check("prerendered-status", pre.status === 200, `GET /prerendered -> ${pre.status}`);
  check("prerendered-content", preText.includes("this-page-is-prerendered"), preText.slice(0, 120).replace(/\n/g, " "));

  // 4. a client asset (immutable app bundle)
  const appDir = "_app";
  const immutableDir = path.join(clientDir, appDir, "immutable");
  let assetPath: string | undefined;
  const findAsset = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) findAsset(p);
      else if (!assetPath && p.endsWith(".js")) assetPath = p;
    }
  };
  findAsset(immutableDir);
  if (assetPath) {
    const rel = `/${path.relative(clientDir, assetPath)}`;
    const asset = yield* get(rel);
    check("client-asset", asset.status === 200, `GET ${rel} -> ${asset.status}`);
  } else {
    check("client-asset", false, "no immutable js asset found");
  }
});

const layer = RuntimeServices.layerRuntime({
  api: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "spike-dummy-account" },
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
);

await program.pipe(
  Effect.scoped,
  Effect.provide(layer),
  Effect.runPromise,
);

const failed = assertions.filter((a) => !a.ok);
console.log(`\n[spike] ${assertions.length - failed.length}/${assertions.length} assertions passed`);
// the runtime's exit hooks / loopback server keep the event loop alive after
// the scope closes — exit explicitly
process.exit(failed.length > 0 ? 1 : 0);
