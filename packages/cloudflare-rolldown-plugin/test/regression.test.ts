import { createMiniflareFromRolldown } from "@distilled.cloud/test-utils/miniflare";
import { describe, expect, it } from "vitest";
import { buildFixture } from "./utils/build-fixture";

describe("regression", () => {
  it("bundles mysql2", async () => {
    const pluginOptions = {
      compatibilityDate: "2025-07-01",
      compatibilityFlags: ["nodejs_compat"],
    };
    const built = await buildFixture({
      fixture: "regression/mysql2",
      pluginOptions,
    });
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      ...pluginOptions,
      bindings: {
        DATABASE_URL: process.env.MYSQL_DATABASE_URL!,
      },
    });
    expect(await miniflare.fetchJson<{ result: number }>("/")).toEqual({ result: 1 });
  });
});
