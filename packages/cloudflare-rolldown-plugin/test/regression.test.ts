import { createMiniflareFromRolldown } from "@distilled.cloud/test-utils/miniflare";
import { assert, describe, expect, it } from "vitest";
import { buildFixture } from "./utils/build-fixture";

describe("regression", () => {
  it("bundles mysql2", async () => {
    assert(process.env.TEST_MYSQL_URL, "TEST_MYSQL_URL is not set");
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
        DATABASE_URL: process.env.TEST_MYSQL_URL,
      },
    });
    expect(await miniflare.fetchJson<{ sql: string }>("/")).toMatchObject({ sql: "SELECT 1" });
  });

  // A realistic @rocicorp/zero worker (modeled on rocicorp/hello-zero-cf) that
  // transitively pulls in @databases/sql + @databases/escape-identifier (both
  // CJS). This case currently bundles and runs cleanly: zero's own ESM imports
  // happen to avoid the problematic CJS-default-import shape. We keep this as a
  // regression guard so we notice if that ever changes.
  it("bundles @rocicorp/zero and its transitive @databases/* dependencies", async () => {
    const pluginOptions = {
      compatibilityDate: "2025-07-01",
      compatibilityFlags: ["nodejs_compat"],
    };
    const built = await buildFixture({
      fixture: "regression/zero-databases",
      pluginOptions,
    });
    await using miniflare = await createMiniflareFromRolldown(built.output, pluginOptions);
    const queryResponse = await miniflare.fetch("/api/get-queries", {
      method: "POST",
      body: JSON.stringify([{ id: "1", name: "users", args: [] }]),
    });
    const queryBody = await queryResponse.text();
    expect(
      queryResponse.ok || queryResponse.status === 400,
      `unexpected status ${queryResponse.status}: ${queryBody}`,
    ).toBe(true);
    const body = await miniflare.fetchText("/");
    expect(body, `expected JSON response but got: ${body}`).toMatch(/^\{/);
    const response = JSON.parse(body) as {
      ok: boolean;
      tables: Array<string>;
      queries: Array<string>;
      mutators: Array<string>;
    };
    expect(response.ok).toBe(true);
    expect(response.tables).toEqual(expect.arrayContaining(["user", "message"]));
    expect(response.queries).toEqual(
      expect.arrayContaining(["users", "messages", "searchMessages"]),
    );
    expect(response.mutators).toContain("create");
  });

  // Reproduces the underlying CJS/ESM default-import interop bug for
  // TS-compiled CJS packages whose `module.exports` is an object with both
  // `__esModule: true` and `exports.default = X`. Rolldown's Node-style
  // interop heuristic (which activates because our importer is in a package
  // with `"type": "module"`) maps the default import to the whole
  // `module.exports` object rather than `module.exports.default`, so calling
  // the imported value as a function throws `TypeError: ... is not a function`
  // at runtime.
  //
  // The `cjs-default-interop` plugin papers over this by detecting modules
  // that match the TS-compiled CJS shape and rewriting them through an ESM
  // shim that handles both interop interpretations.
  it("handles default imports of TS-compiled CJS packages", async () => {
    const pluginOptions = {
      compatibilityDate: "2025-07-01",
      compatibilityFlags: ["nodejs_compat"],
    };
    const built = await buildFixture({
      fixture: "regression/databases-cjs-interop",
      pluginOptions,
    });
    await using miniflare = await createMiniflareFromRolldown(built.output, pluginOptions);
    const body = await miniflare.fetchText("/");
    expect(body, `expected JSON response but got: ${body}`).toMatch(/^\{/);
    const response = JSON.parse(body) as { result: string };
    expect(response.result).toBe("hello");
  });
});
