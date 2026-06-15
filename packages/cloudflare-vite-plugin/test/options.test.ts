import { describe, expect, test } from "vitest";
import { normalizeCloudflareVitePluginOptions } from "../src/options.ts";

describe("Cloudflare Vite plugin options", () => {
  test("normalizes top-level asset routing into worker assets", () => {
    const options = normalizeCloudflareVitePluginOptions({
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*"],
      },
    });

    expect(options.assets).toEqual({
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    });
    expect(options.worker?.assets).toEqual({
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    });
  });

  test("preserves worker asset fields while exposing routing fields for deploy", () => {
    const options = normalizeCloudflareVitePluginOptions({
      worker: {
        name: "app",
        assets: {
          directory: "/tmp/ignored-by-vite-build",
          headers: "_headers",
          htmlHandling: "none",
        },
      },
    });

    expect(options.assets).toEqual({ htmlHandling: "none" });
    expect(options.worker?.assets).toEqual({
      directory: "/tmp/ignored-by-vite-build",
      headers: "_headers",
      htmlHandling: "none",
    });
  });

  test("rejects conflicting asset routing options", () => {
    expect(() =>
      normalizeCloudflareVitePluginOptions({
        assets: { notFoundHandling: "single-page-application" },
        worker: {
          assets: { notFoundHandling: "404-page" },
        },
      }),
    ).toThrow(
      `[cloudflare] assets.notFoundHandling is configured both at the top level and under worker.assets with different values.`,
    );
  });
});
