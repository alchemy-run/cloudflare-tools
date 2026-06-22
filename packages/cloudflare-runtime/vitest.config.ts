import { InternalWorkerImportPlugin } from "@distilled.cloud/build-utils";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [InternalWorkerImportPlugin()],
});
