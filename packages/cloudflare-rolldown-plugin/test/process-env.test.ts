import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";
import cloudflare from "../src/plugin";
import { createMiniflare } from "./utils/miniflare";

const OPTIONS = {
  compatibilityDate: "2025-07-01",
};

describe("process.env", async () => {
  const bundle = await rolldown({
    input: "test/fixtures/process-env.ts",
    plugins: [cloudflare(OPTIONS)],
  });
  const result = await bundle.generate({
    file: "dist/process-env/index.js",
    sourcemap: true,
    format: "esm",
  });

  it("responds to fetch /", async () => {
    await using miniflare = await createMiniflare(result, OPTIONS);
    const response = await miniflare.dispatchFetch("http://localhost/");
    expect(await response.text()).toBe("ok");
  });

  it("replaces process.env.NODE_ENV with 'production'", async () => {
    await using miniflare = await createMiniflare(result, OPTIONS);
    const response = await miniflare.dispatchFetch("http://localhost/node-env");
    expect(await response.text()).toBe("production");
  });

  it("replaces global.process.env.NODE_ENV with 'production'", async () => {
    await using miniflare = await createMiniflare(result, OPTIONS);
    const response = await miniflare.dispatchFetch("http://localhost/global-node-env");
    expect(await response.text()).toBe("production");
  });

  it("replaces globalThis.process.env.NODE_ENV with 'production'", async () => {
    await using miniflare = await createMiniflare(result, OPTIONS);
    const response = await miniflare.dispatchFetch("http://localhost/globalthis-node-env");
    expect(await response.text()).toBe("production");
  });
});
