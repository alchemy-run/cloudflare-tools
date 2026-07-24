import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { fromHarnessOptions, resolveDevEnvironment, resolveExportTarget } from "../src/index.ts";

describe("resolveDevEnvironment", () => {
  it("resolves Text-style binding hooks to env values", () => {
    const bindings = [Effect.succeed({ name: "SECRET", text: "value" })];
    expect(resolveDevEnvironment(bindings)).toEqual({ SECRET: "value" });
  });

  it("parses Json-style binding hooks", () => {
    const bindings = [Effect.succeed({ name: "CONFIG", json: JSON.stringify({ a: 1 }) })];
    expect(resolveDevEnvironment(bindings)).toEqual({ CONFIG: { a: 1 } });
  });

  it("skips hooks that fail or require runtime services", () => {
    const bindings = [
      Effect.fail(new Error("boom")),
      // an async hook cannot be resolved synchronously
      Effect.promise(async () => ({ name: "LATER", text: "no" })),
      // a hook that dies when its runtime services are missing
      Effect.sync(() => {
        throw new Error("requires PluginContext");
      }),
      Effect.succeed({ name: "OK", text: "yes" }),
    ];
    expect(resolveDevEnvironment(bindings)).toEqual({ OK: "yes" });
  });

  it("skips non-Effect entries and bindings without usable values", () => {
    const bindings = [
      { name: "PLAIN" },
      Effect.succeed({ name: "KV", kvNamespace: "service" }),
      Effect.succeed({ name: "BAD_JSON", json: "{" }),
    ];
    expect(resolveDevEnvironment(bindings)).toEqual({});
  });

  it("returns an empty env when bindings are omitted", () => {
    expect(resolveDevEnvironment(undefined)).toEqual({});
  });
});

describe("fromHarnessOptions", () => {
  it("maps the shared vite options onto SvelteKit options", () => {
    const options = fromHarnessOptions({
      vite: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: {
          bindings: [Effect.succeed({ name: "SECRET", text: "value" })],
          assets: { notFoundHandling: "404-page" },
        },
      },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(options.adapter?.notFoundHandling).toBe("404-page");
    expect(options.dev?.env).toEqual({ SECRET: "value" });
  });

  it("prefers the target-scoped carriage over the deprecated vite alias", () => {
    const options = fromHarnessOptions({
      target: {
        cloudflare: {
          worker: {
            compatibilityDate: "2026-03-10",
            worker: {
              bindings: [Effect.succeed({ name: "SCOPED", text: "yes" })],
              assets: { notFoundHandling: "single-page-application" },
            },
          },
        },
      },
      vite: {
        compatibilityDate: "1999-01-01",
        worker: { assets: { notFoundHandling: "none" } },
      },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.adapter?.notFoundHandling).toBe("single-page-application");
    expect(options.dev?.env).toEqual({ SCOPED: "yes" });
  });

  it("falls back to the deprecated vite alias when no target is scoped", () => {
    const options = fromHarnessOptions({
      vite: { compatibilityDate: "2026-03-10" },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
  });

  it("tolerates fully-empty options", () => {
    const options = fromHarnessOptions({});
    expect(options.compatibilityDate).toBeUndefined();
    expect(options.dev?.env).toEqual({});
  });
});

describe("resolveExportTarget", () => {
  it("accepts a plain string target", () => {
    expect(resolveExportTarget("./src/exports/vite/index.js")).toBe("./src/exports/vite/index.js");
  });

  it("picks the import condition (kit's ESM-only ./vite export)", () => {
    expect(
      resolveExportTarget({
        types: "./types/index.d.ts",
        import: "./src/exports/vite/index.js",
      }),
    ).toBe("./src/exports/vite/index.js");
  });

  it("falls back to default and resolves nested conditions", () => {
    expect(resolveExportTarget({ default: { import: "./dist/index.js" } })).toBe("./dist/index.js");
  });

  it("returns undefined for unusable entries", () => {
    expect(resolveExportTarget(undefined)).toBeUndefined();
    expect(resolveExportTarget({ types: "./types/index.d.ts" })).toBeUndefined();
    expect(resolveExportTarget(null)).toBeUndefined();
  });
});
