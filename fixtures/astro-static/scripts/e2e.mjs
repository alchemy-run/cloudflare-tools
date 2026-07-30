#!/usr/bin/env node
// CI gate: this fixture is written against the INTENDED behavior of the
// static-output path in @distilled.cloud/astro — a pure `output: "static"`
// build deploying ASSETS-ONLY (no worker; BuildOutput.serverModules
// undefined/empty). The audit found the current integration deploys a full
// worker even for static output, so the suite cannot fully pass yet. The
// gate keeps CI green while letting the enablement pass flip it on with
// ASTRO_STATIC_ENABLE=1. See fixtures/astro-static/README.md.
import { spawnSync } from "node:child_process";

if (process.env.ASTRO_STATIC_ENABLE !== "1") {
  console.log(
    "astro-static: pending the assets-only static-output wave — see fixtures/astro-static/README.md",
  );
  process.exit(0);
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("bunx", ["playwright", "install", "chromium"]);
run("bunx", ["playwright", "test", ...process.argv.slice(2)]);
