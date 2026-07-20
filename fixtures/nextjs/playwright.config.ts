import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  // The dev worker fixture may fall back to a full OpenNext build when
  // dist/build.json is missing, so keep generous timeouts.
  timeout: 120_000,
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
