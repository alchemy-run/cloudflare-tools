import { InternalWorkerImportPlugin } from "@distilled.cloud/build-utils";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    InternalWorkerImportPlugin({ workersRoot: path.resolve(import.meta.dirname, "dist/workers") }),
  ],
  test: {
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Binding sims are timing-sensitive (real Chrome launches, rate-limit
    // windows, queue delivery delays) and the small CI runners run the whole
    // 460+-test suite under load — absorb runner starvation the same way the
    // fixture playwright configs do (`retries: CI ? 2 : 0`).
    retry: process.env.CI ? 2 : 0,
    // The Windows CI runner is resource-constrained; running test files in
    // parallel starves the event loop while many `workerd` processes spawn at
    // once. That inflates wall-clock time for timing-sensitive tests (e.g.
    // queue delivery delays) and pushes layer setup/teardown hooks past their
    // timeout. Serializing files keeps peak load manageable there.
    fileParallelism: process.platform !== "win32",
  },
});
