// vocs 2.6.0's `getMdxLayoutImport` walks parent directories looking for a
// layout with a `dir !== "/"` termination check that never matches a Windows
// drive root (`D:\`), so the MDX build recurses until "Maximum call stack
// size exceeded" and every page fails to compile. Upstream vocs bug — this
// fixture already pins vocs exactly because of its brittle internals (see
// framework.ts). Skip on Windows CI only.
import { execSync } from "node:child_process";

if (process.platform === "win32" && process.env.CI) {
  console.log(
    "fixtures/vocs e2e skipped on Windows CI: vocs getMdxLayoutImport infinite recursion at drive roots (see scripts/e2e.mjs).",
  );
  process.exit(0);
}

// The vocs MDX build itself is what overflows on Windows, so it lives
// behind the gate too (it used to run from `pretest`).
execSync("bun run build", { stdio: "inherit" });
// `bun run` puts the fixture's node_modules/.bin on PATH for playwright.
execSync("bun run test:e2e", { stdio: "inherit" });
