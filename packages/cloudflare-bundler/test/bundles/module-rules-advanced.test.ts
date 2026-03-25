/**
 * Tests advanced module rule behaviors: fallthrough, custom rules, and
 * interaction with default rules.
 *
 * - User rules with `fallthrough: true` allow default rules of the same type
 * - Custom file extensions can be collected as specific module types
 * - Default rules still work alongside custom rules
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadFixture } from "../harness/fixture.js";
import { withRunner } from "../harness/miniflare-runner.js";
import { bundleWithRolldown } from "../harness/rolldown-bundler.js";
import type { BundleConfig, BundleResult } from "../harness/types.js";

describe("module-rules-advanced", () => {
  let config: BundleConfig;

  it.beforeAll(async () => {
    config = await loadFixture("module-rules-advanced");
  });

  let bundle: BundleResult;

  it.beforeAll(async () => {
    bundle = await Effect.runPromise(bundleWithRolldown(config));
  });

  it("builds successfully", () => {
    expect(bundle.main).toBeTruthy();
  });

  it("collects .custom file as Text module via user rule", () => {
    const customModule = bundle.modules.find((m) => m.name.includes("data.custom"));
    expect(customModule).toBeDefined();
    expect(customModule!.type).toBe("Text");
  });

  it("collects .txt file via default Text rule (fallthrough allows it)", () => {
    const textModule = bundle.modules.find((m) => m.name.includes("info.txt"));
    expect(textModule).toBeDefined();
    expect(textModule!.type).toBe("Text");
  });

  it.effect("custom text module returns content", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/custom");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("custom text content");
    }),
  );

  it.effect("default text module returns content", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/text");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("regular text info");
    }),
  );

  it.effect("responds to fetch /", () =>
    withRunner({ bundle, config }, async (runner) => {
      const res = await runner.fetch("http://localhost/");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    }),
  );
});
