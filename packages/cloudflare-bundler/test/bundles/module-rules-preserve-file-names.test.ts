import { beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe.concurrent("module-rules-preserve-file-names", () => {
  let config: BundleConfig;
  let bundle: BundleResult;

  beforeAll(async () => {
    config = await loadFixture("module-rules-preserve-file-names");
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("preserves the original additional module file name", () => {
    const textModule = bundle.modules.find((m) => m.type === "Text");
    expect(textModule?.name).toBe("message.txt");
  });

  it.effect("returns the text module contents", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/text");
      expect(res.status).toBe(200);
      expect((await res.text()).trim()).toBe("preserved text module");
    }),
  );
});
