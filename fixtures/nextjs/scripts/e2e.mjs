// The OpenNext build copies the NFT-traced node_modules into
// `.open-next/server-functions/default/node_modules`. Under bun's isolated
// linker that tree is built from `.bun` store junctions, and the copy leaves
// them broken on Windows — esbuild's final bundle pass then fails with
// `Cannot read directory ".open-next/.../node_modules/.bun/.../react": Access
// is denied`. Skip the e2e on Windows until the copy re-materializes
// junctioned directories (upstream OpenNext has the same constraint).
import { execSync } from "node:child_process";

if (process.platform === "win32") {
  console.log(
    "fixtures/nextjs e2e skipped on Windows: OpenNext build cannot traverse bun-store junctions (see scripts/e2e.mjs).",
  );
  process.exit(0);
}

execSync("bun run build", { stdio: "inherit" });
execSync("bun x playwright test", { stdio: "inherit" });
