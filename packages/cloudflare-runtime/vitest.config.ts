import { InternalWorkerImportPlugin } from "@distilled.cloud/build-utils";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    InternalWorkerImportPlugin({ workersRoot: path.resolve(import.meta.dirname, "dist/workers") }),
  ],
});
