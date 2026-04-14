import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
