import type { MinimalPluginContext } from "rolldown";
import { describe, expect, it } from "vitest";
import { makeOptionsPlugin } from "../src/plugins/options.js";

describe("options plugin", () => {
  it("applies the Cloudflare defaults", () => {
    const plugin = makeOptionsPlugin({});
    const input = {};
    const output = plugin.options.call({} as MinimalPluginContext, input);

    expect(output.platform).toBe("neutral");
    expect(output.resolve?.conditionNames).toEqual([
      "workerd",
      "worker",
      "module",
      "browser",
      "production",
    ]);
    expect(output.resolve?.extensions).toEqual([
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
      ".cjs",
      ".cts",
      ".ctx",
    ]);
    expect(output.transform?.target).toBe("es2024");
  });

  it("defines production node env values and stubs process.env without nodejs_compat", () => {
    const plugin = makeOptionsPlugin({});
    const input = {};
    const output = plugin.options.call({} as MinimalPluginContext, input);

    expect(output.transform?.define).toMatchObject({
      "process.env.NODE_ENV": '"production"',
      "global.process.env.NODE_ENV": '"production"',
      "globalThis.process.env.NODE_ENV": '"production"',
      "process.env": "{}",
      "global.process.env": "{}",
      "globalThis.process.env": "{}",
    });
  });

  it("does not stub process.env with nodejs_compat enabled", () => {
    const plugin = makeOptionsPlugin({
      compatibilityFlags: ["nodejs_compat"],
    });
    const input = {};
    const output = plugin.options.call({} as MinimalPluginContext, input);

    expect(output.transform?.define).toMatchObject({
      "process.env.NODE_ENV": '"production"',
      "global.process.env.NODE_ENV": '"production"',
      "globalThis.process.env.NODE_ENV": '"production"',
    });
    expect(output.transform?.define?.["process.env"]).toBeUndefined();
    expect(output.transform?.define?.["global.process.env"]).toBeUndefined();
    expect(output.transform?.define?.["globalThis.process.env"]).toBeUndefined();
  });

  it("defines navigator.userAgent only when the compatibility date supports it", () => {
    const withNavigator = makeOptionsPlugin({
      compatibilityDate: "2022-03-21",
    });
    const withoutNavigator = makeOptionsPlugin({
      compatibilityDate: "2022-03-20",
    });

    const withNavigatorOutput = withNavigator.options.call({} as MinimalPluginContext, {});
    const withoutNavigatorOutput = withoutNavigator.options.call({} as MinimalPluginContext, {});

    expect(withNavigatorOutput.transform?.define?.["navigator.userAgent"]).toBe(
      '"Cloudflare-Workers"',
    );
    expect(withoutNavigatorOutput.transform?.define?.["navigator.userAgent"]).toBeUndefined();
  });
});
