// Runs the Playwright suite. The live-mode specs always run; the dev-mode
// specs are WRITTEN but pending until the Nuxt dev transport lands (SSR in a
// Node worker thread with `event.context.cloudflare` served wrangler-free) —
// test/smoke.test.ts only registers the "dev" describe block when
// NUXT_DEV_ENABLE=1 is set.
import { execSync } from "node:child_process";

if (!process.env.NUXT_DEV_ENABLE) {
  console.log(
    "fixtures/nuxt: dev-mode suite pending (Nuxt dev transport lands in the next phase); " +
      "set NUXT_DEV_ENABLE=1 to run it. Running the live suite.",
  );
}

// `bun run` puts the fixture's node_modules/.bin on PATH for playwright.
execSync("bun run test:e2e", { stdio: "inherit" });
