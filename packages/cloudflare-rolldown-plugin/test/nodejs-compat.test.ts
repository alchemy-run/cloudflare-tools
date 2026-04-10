import { describe, expect, it } from "vitest";
import { makeNodejsCompatPlugin } from "../src/plugins/nodejs-compat.js";
import { buildFixture } from "./utils/build-fixture";
import { createMiniflare } from "./utils/miniflare";

describe("nodejs_compat", () => {
  it("runs node builtin imports with nodejs_compat enabled", async () => {
    const built = await buildFixture({
      fixture: "node-compat/index.ts",
      pluginOptions: {
        compatibilityDate: "2025-07-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    });

    await using miniflare = await createMiniflare(built.output, {
      compatibilityDate: "2025-07-01",
      compatibilityFlags: ["nodejs_compat"],
    });

    expect(await miniflare.fetchText("/")).toBe("OK!");
  });

  it("creates and injects virtual globals for nodejs_compat entries", async () => {
    const plugins = makeNodejsCompatPlugin({
      compatibilityDate: "2025-07-01",
      compatibilityFlags: ["nodejs_compat"],
    }) as Array<{
      name: string;
      resolveId?: { handler?: (...args: Array<unknown>) => unknown };
      load?: { handler?: (...args: Array<unknown>) => unknown };
      transform?: (code: string, id: string) => string | undefined;
    }>;

    const injectsPlugin = plugins.find(
      (plugin) => plugin.name === "rolldown-plugin-cloudflare:nodejs-compat:injects",
    );
    const compatPlugin = plugins.find(
      (plugin) => plugin.name === "rolldown-plugin-cloudflare:nodejs-compat",
    );

    expect(injectsPlugin).toBeDefined();
    expect(compatPlugin).toBeDefined();

    const resolved = injectsPlugin?.resolveId?.handler?.("virtual:nodejs-global-inject/process");
    expect(resolved).toEqual({ id: "virtual:nodejs-global-inject/process" });

    const loaded = injectsPlugin?.load?.handler?.("virtual:nodejs-global-inject/process");
    expect(loaded).toContain("globalThis.process = virtualModule;");

    const transformed = compatPlugin?.transform?.call(
      {
        getModuleInfo() {
          return { isEntry: true };
        },
      },
      'export default { fetch() { return new Response("ok"); } };',
      "test/fixtures/node-compat/index.ts",
    );

    expect(transformed).toContain('import "@cloudflare/unenv-preset/polyfill/performance";');
    expect(transformed).toContain('import "virtual:nodejs-global-inject/process";');
  });

  it("warns when unresolved Node builtins are imported without nodejs_compat", async () => {
    const plugin = makeNodejsCompatPlugin({
      compatibilityDate: "2025-07-01",
    }) as {
      buildStart?: () => void;
      buildEnd?: () => void;
      resolveId?: { handler?: (...args: Array<unknown>) => Promise<unknown> };
    };

    const warnings: Array<string> = [];
    plugin.buildStart?.call({});

    await plugin.resolveId?.handler?.call({}, "node:fs", "test/fixtures/example-a.ts", {});
    await plugin.resolveId?.handler?.call({}, "node:fs", "test/fixtures/example-b.ts", {});

    plugin.buildEnd?.call({
      warn(message: string) {
        warnings.push(message);
      },
    });

    console.log(warnings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unexpected Node.js imports.");
    expect(warnings[0]).toContain('Do you need to enable the "nodejs_compat" compatibility flag?');
    expect(warnings[0]).toContain("https://developers.cloudflare.com/workers/runtime-apis/nodejs/");
    expect(warnings[0]).toContain('- "node:fs" imported from "test/fixtures/example-a.ts"');
    expect(warnings[0]).toContain('- "node:fs" imported from "test/fixtures/example-b.ts"');
  });
});
