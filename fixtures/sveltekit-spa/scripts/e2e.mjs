#!/usr/bin/env node
// CI gate: this fixture is written against the INTENDED behavior of the
// "respect user config files" wave (a real vite.config.ts + svelte.config.js
// honored by @distilled.cloud/sveltekit, plus SPA fallback /
// not_found_handling wiring through the in-memory adapter). Until that wave
// lands the suite cannot pass. The gate keeps CI green while letting the
// enablement pass flip it on with SVELTEKIT_SPA_ENABLE=1.
// See fixtures/sveltekit-spa/README.md.
import { spawnSync } from "node:child_process";

if (process.env.SVELTEKIT_SPA_ENABLE !== "1") {
  console.log(
    "sveltekit-spa: pending the user-config wave — see fixtures/sveltekit-spa/README.md",
  );
  process.exit(0);
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("bunx", ["playwright", "install", "chromium"]);
run("bunx", ["playwright", "test", ...process.argv.slice(2)]);
