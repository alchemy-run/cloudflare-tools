import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  // Windows CI runs every fixture e2e concurrently; absorb runner flakiness.
  retries: process.env.CI ? 2 : 0,
  // The dev worker fixture runs a full OpenNext build on start (preview
  // parity — no build.json reuse), so keep generous timeouts.
  timeout: 120_000,
  // Serialize workers: the dev fixture's OpenNext build rewrites
  // `.open-next/assets` on disk, which a concurrently-running live
  // (miniflare) worker serves from — parallel workers race on it.
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        colorScheme: "light",
        deviceScaleFactor: 1,
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
