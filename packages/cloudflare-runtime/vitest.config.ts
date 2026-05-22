import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

function workerVirtualModule(): Plugin {
  return {
    name: "distilled:worker-virtual-module",
    enforce: "pre",
    resolveId(id, importer) {
      if (!id.startsWith("worker:")) return null;
      const specifier = id.slice("worker:".length);
      const require = createRequire(importer ?? import.meta.url);
      const absoluteTs = require.resolve(specifier);
      const relativeFromSrc = path.relative(path.resolve(here, "src"), absoluteTs);
      const relativeMjs = relativeFromSrc.replace(/\.ts$/, ".mjs");
      return path.resolve(here, "dist/workers", relativeMjs);
    },
  };
}

export default defineConfig({
  plugins: [workerVirtualModule()],
});
