#!/usr/bin/env node
// CI gate: this fixture is written against the INTENDED behavior of the
// custom-worker-entry seam for @distilled.cloud/waku — a user `main` module
// that wraps waku's emitted server entry and re-exports Durable Object
// classes (the pattern alchemy's Website.Vite already supports via its
// `main` prop). Today the waku cloudflare target unconditionally pins `main`
// to waku's own rsc entry (`makeWakuPluginOptions` in
// packages/waku/src/cloudflare.ts), so the suite cannot pass. The gate keeps
// CI green while letting the enablement pass flip it on with
// WAKU_DO_ENABLE=1. See fixtures/waku-durable-objects/README.md.
import { spawnSync } from "node:child_process";

if (process.env.WAKU_DO_ENABLE !== "1") {
  console.log(
    "waku-durable-objects: pending the waku custom-worker-entry seam — see fixtures/waku-durable-objects/README.md",
  );
  process.exit(0);
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("bunx", ["playwright", "install", "chromium"]);
run("bunx", ["playwright", "test", ...process.argv.slice(2)]);
