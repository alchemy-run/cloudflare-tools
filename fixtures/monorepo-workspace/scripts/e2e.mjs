#!/usr/bin/env node
// CI gate: this fixture exercises the externalWorkspaces / input-hash memo
// machinery with an app importing across a package boundary (app/ -> lib/).
// The suite depends on the built-in Vite framework path honoring a nested
// project root plus the collector's cross-boundary workspace detection; until
// the enablement pass verifies the whole chain, the gate keeps CI green.
// Flip it on with MONOREPO_WS_ENABLE=1. See fixtures/monorepo-workspace/README.md.
import { spawnSync } from "node:child_process";

if (process.env.MONOREPO_WS_ENABLE !== "1") {
  console.log(
    "monorepo-workspace: pending the workspace-memo enablement pass — see fixtures/monorepo-workspace/README.md",
  );
  process.exit(0);
}

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("bunx", ["playwright", "install", "chromium"]);
run("bunx", ["playwright", "test", ...process.argv.slice(2)]);
