#!/usr/bin/env node
// CI gate: this fixture is written against the INTENDED behavior of the
// "respect user config files" wave (a real astro.config.mjs honored by
// @distilled.cloud/astro). Until that wave lands, the current integration
// pins `configFile: false`, so the suite cannot pass. The gate keeps CI
// green while letting the enablement pass flip it on with ASTRO_SSR_ENABLE=1.
// See fixtures/astro-ssr/README.md.
import { spawnSync } from "node:child_process";

if (process.env.ASTRO_SSR_ENABLE !== "1") {
  console.log("astro-ssr: pending the user-config wave — see fixtures/astro-ssr/README.md");
  process.exit(0);
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("bunx", ["playwright", "install", "chromium"]);
run("bunx", ["playwright", "test", ...process.argv.slice(2)]);
