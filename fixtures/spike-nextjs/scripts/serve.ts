// Serve the final bundle (dist-worker/) with @distilled.cloud/cloudflare-runtime
// (workerd, no miniflare, no wrangler) and run HTTP assertions against it.
//
// Run with: bun scripts/serve.ts [--keep]
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Module } from "@distilled.cloud/cloudflare-runtime";
import * as Runtime from "@distilled.cloud/cloudflare-runtime/Runtime";
import * as RuntimeServices from "@distilled.cloud/cloudflare-runtime/RuntimeServices";
import * as Assets from "@distilled.cloud/cloudflare-runtime/bindings/assets/Assets";
import * as DurableObjectNamespace from "@distilled.cloud/cloudflare-runtime/bindings/DurableObjectNamespace";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as fs from "node:fs";
import * as path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..");
const distWorker = path.join(appDir, "dist-worker");
const assetsDir = path.join(appDir, ".open-next", "assets");
const keep = process.argv.includes("--keep");

// ---------------------------------------------------------------------------
// Collect modules from the final bundle, entry first.
// ---------------------------------------------------------------------------
const collectModules = (): Array<Module> => {
  const modules: Array<Module> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const name = path.relative(distWorker, full).split(path.sep).join("/");
      if (name === "meta.json") continue;
      if (name.endsWith(".js") || name.endsWith(".mjs")) {
        modules.push({ name, type: "ESModule", content: fs.readFileSync(full, "utf8") });
      } else if (name.endsWith(".wasm")) {
        modules.push({ name, type: "Wasm", content: new Uint8Array(fs.readFileSync(full)) });
      } else if (name.endsWith(".bin")) {
        modules.push({ name, type: "Data", content: new Uint8Array(fs.readFileSync(full)) });
      }
    }
  };
  walk(distWorker);
  modules.sort((a, b) =>
    a.name === "worker.js" ? -1 : b.name === "worker.js" ? 1 : a.name.localeCompare(b.name),
  );
  if (process.env.SPIKE_DEBUG) {
    // Wrap the entry so workerd-level uncaught exceptions surface as HTTP 599
    // bodies with stacks (workerd only prints them with --verbose, which
    // Runtime doesn't expose).
    modules.unshift({
      name: "debug-entry.js",
      type: "ESModule",
      content: [
        `import worker from "./worker.js";`,
        `export * from "./worker.js";`,
        `export default {`,
        `  async fetch(request, env, ctx) {`,
        `    try {`,
        `      const url = new URL(request.url);`,
        `      if (url.pathname === "/__spike/do-probe") {`,
        `        // Same-script SQLite-backed DO probe: instantiate DOQueueHandler`,
        `        // (runs its SQL DDL in blockConcurrencyWhile) and invoke the`,
        `        // revalidate RPC, which HEAD-fetches WORKER_SELF_REFERENCE.`,
        `        const id = env.NEXT_CACHE_DO_QUEUE.idFromName("spike-probe");`,
        `        const stub = env.NEXT_CACHE_DO_QUEUE.get(id);`,
        `        await stub.revalidate({`,
        `          MessageDeduplicationId: "spike-probe",`,
        `          MessageGroupId: "spike",`,
        `          MessageBody: { host: url.host, url: "/isr", eTag: "spike", lastModified: Date.now() },`,
        `        });`,
        `        return Response.json({ ok: true });`,
        `      }`,
        `      return await worker.fetch(request, env, ctx);`,
        `    } catch (e) {`,
        `      return new Response(String(e?.stack ?? e), { status: 599 });`,
        `    }`,
        `  },`,
        `};`,
      ].join("\n"),
    });
  }
  return modules;
};

// ---------------------------------------------------------------------------
// Runtime layer (local-only; accountId is a dummy — no remote bindings used).
// ---------------------------------------------------------------------------
const layer = RuntimeServices.layerRuntime({
  api: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "spike-local-account" },
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
);

// WORKER_SELF_REFERENCE: a service binding pointing back at the user worker's
// own workerd service ("user-worker" — SERVICE_USER_WORKER in
// cloudflare-runtime/src/internal/constants.ts). There is no public helper for
// a same-script service binding; a BindingHook is just an Effect yielding a
// workerd Worker_Binding, so we synthesize one.
const selfReference = Effect.succeed({
  name: "WORKER_SELF_REFERENCE",
  service: { name: "user-worker" },
});

const check = async (
  name: string,
  fn: () => Promise<{ ok: boolean; detail: string }>,
  results: Array<{ name: string; ok: boolean; detail: string }>,
) => {
  try {
    const { ok, detail } = await fn();
    results.push({ name, ok, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: `threw: ${error}` });
  }
};

const program = Effect.gen(function* () {
  const modules = collectModules();
  yield* Effect.log(`[spike] loaded ${modules.length} modules (entry: ${modules[0]?.name})`);
  const runtime = yield* Runtime.Runtime;
  const url = yield* runtime.start({
    name: "spike-nextjs",
    compatibilityDate: "2026-05-12",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    bindings: [
      Assets.local("ASSETS"),
      selfReference,
      // Same-script DO namespace for the OpenNext revalidation queue class
      // (exported by worker.js). SQLite-backed.
      DurableObjectNamespace.local({
        binding: "NEXT_CACHE_DO_QUEUE",
        className: "DOQueueHandler",
      }),
    ],
    modules,
    assets: {
      directory: assetsDir,
      runWorkerFirst: true,
    },
    durableObjectNamespaces: [{ className: "DOQueueHandler", sql: true }],
  });
  yield* Effect.log(`[spike] worker running at ${url}`);

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const get = (p: string, init?: RequestInit) => fetch(new URL(p, url), init);

  yield* Effect.promise(async () => {
    // 1. SSR page
    await check(
      "ssr page /",
      async () => {
        const res = await get("/");
        const body = await res.text();
        return {
          ok:
            res.status === 200 &&
            body.includes("spike-nextjs SSR page") &&
            body.includes("rendered-at:"),
          detail: `status=${res.status} hasMarker=${body.includes("rendered-at:")}`,
        };
      },
      results,
    );

    // 2. API route
    await check(
      "api route /api/hello",
      async () => {
        const res = await get("/api/hello");
        const json: any = res.status === 200 ? await res.json() : undefined;
        return {
          ok: res.status === 200 && json?.hello === "world",
          detail: `status=${res.status} json=${JSON.stringify(json)}`,
        };
      },
      results,
    );

    // 3. Static asset
    await check(
      "static asset /static.txt",
      async () => {
        const res = await get("/static.txt");
        const body = await res.text();
        return {
          ok: res.status === 200 && body.includes("hello from a static asset"),
          detail: `status=${res.status}`,
        };
      },
      results,
    );

    // 4. _next/static asset (immutable client chunk)
    await check(
      "_next/static asset",
      async () => {
        const staticDir = path.join(assetsDir, "_next", "static");
        let sample: string | undefined;
        const walk = (dir: string, rel: string) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (sample) return;
            if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
            else if (e.name.endsWith(".js")) sample = `${rel}/${e.name}`;
          }
        };
        walk(staticDir, "/_next/static");
        if (!sample) return { ok: false, detail: "no client chunk found on disk" };
        const res = await get(sample);
        return { ok: res.status === 200, detail: `status=${res.status} path=${sample}` };
      },
      results,
    );

    // 5. ISR page — first hit
    const isr1 = await get("/isr");
    const isr1Body = await isr1.text();
    const isr1Stamp = isr1Body.match(/isr-rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
    results.push({
      name: "isr page first hit",
      ok: isr1.status === 200 && !!isr1Stamp,
      detail: `status=${isr1.status} x-nextjs-cache=${isr1.headers.get("x-nextjs-cache")} stamp=${isr1Stamp}`,
    });

    // 6. ISR page — after the 5s revalidate window (read-only static-assets
    //    cache means the stamp should NOT change; this probes that the stale
    //    entry still serves and the revalidation path doesn't crash the worker)
    await new Promise((r) => setTimeout(r, 6500));
    const isr2 = await get("/isr");
    const isr2Body = await isr2.text();
    const isr2Stamp = isr2Body.match(/isr-rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
    results.push({
      name: "isr page after revalidate window",
      ok: isr2.status === 200 && !!isr2Stamp,
      detail: `status=${isr2.status} x-nextjs-cache=${isr2.headers.get("x-nextjs-cache")} stamp=${isr2Stamp} changed=${isr1Stamp !== isr2Stamp}`,
    });

    // give the background revalidation (WORKER_SELF_REFERENCE HEAD fetch) a
    // moment, then hit it again to observe post-revalidation state
    await new Promise((r) => setTimeout(r, 2000));
    const isr3 = await get("/isr");
    const isr3Body = await isr3.text();
    const isr3Stamp = isr3Body.match(/isr-rendered-at:(?:<!-- -->)?(\d+)/)?.[1];
    results.push({
      name: "isr page third hit (post-revalidation)",
      ok: isr3.status === 200,
      detail: `status=${isr3.status} x-nextjs-cache=${isr3.headers.get("x-nextjs-cache")} stamp=${isr3Stamp} changedFromFirst=${isr1Stamp !== isr3Stamp}`,
    });

    // 6.5 Edge middleware: rewrite + header
    await check(
      "middleware rewrite /mw-rewrite",
      async () => {
        const res = await get("/mw-rewrite");
        const json: any = res.status === 200 ? await res.json() : undefined;
        return {
          ok: res.status === 200 && json?.hello === "world",
          detail: `status=${res.status} rewrote=${json?.hello === "world"}`,
        };
      },
      results,
    );

    await check(
      "middleware header on /api/hello",
      async () => {
        const res = await get("/api/hello");
        await res.body?.cancel();
        return {
          ok: res.headers.get("x-spike-middleware") === "passed",
          detail: `x-spike-middleware=${res.headers.get("x-spike-middleware")}`,
        };
      },
      results,
    );

    // 6.8 Same-script SQLite DO probe (debug entry only)
    if (process.env.SPIKE_DEBUG) {
      await check(
        "sqlite DO queue probe /__spike/do-probe",
        async () => {
          const res = await get("/__spike/do-probe");
          const body = await res.text();
          return {
            ok: res.status === 200,
            detail: `status=${res.status} body=${body.slice(0, 200).replaceAll("\n", " | ")}`,
          };
        },
        results,
      );
    }

    // 7. Images binding probe (expected gap: no IMAGES binding locally)
    await check(
      "images probe /_next/image",
      async () => {
        const res = await get("/_next/image?url=%2Fstatic.txt&w=64&q=75");
        return {
          ok: true,
          detail: `status=${res.status} (informational — IMAGES binding gap probe)`,
        };
      },
      results,
    );
  });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
  }
  console.log(`[spike] ${results.length - failed}/${results.length} checks passed`);

  if (keep) {
    yield* Effect.log(`[spike] --keep: serving at ${url} until Ctrl-C`);
    yield* Effect.never;
  }
  return failed;
});

const failed = await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<number>,
);
process.exit(failed === 0 ? 0 : 1);
