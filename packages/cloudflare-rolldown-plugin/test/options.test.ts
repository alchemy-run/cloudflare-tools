import type { MinimalPluginContext } from "rolldown";
import { assert, describe, expect, it } from "vitest";
import { optionsPlugin } from "../src/plugins/options.js";

describe("options plugin", () => {
  it("applies the Cloudflare defaults", () => {
    const plugin = optionsPlugin.rolldown({});
    const input = {};
    assert(typeof plugin.options === "function", "plugin.options is not a function");
    const output = plugin.options.call({} as MinimalPluginContext, input);
    assert(output, "output is not defined");
    assert(!(output instanceof Promise), "output is a promise");

    expect(output.platform).toBe("neutral");
    expect(output.resolve?.conditionNames).toEqual([
      "workerd",
      "worker",
      "module",
      "browser",
      "production",
    ]);
    expect(output.resolve?.mainFields).toEqual([
      "browser",
      "module",
      "jsnext:main",
      "jsnext",
      "main",
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
    const plugin = optionsPlugin.rolldown({});
    const input = {};
    assert(typeof plugin.options === "function", "plugin.options is not a function");
    const output = plugin.options!.call({} as MinimalPluginContext, input);
    assert(output, "output is not defined");
    assert(!(output instanceof Promise), "output is a promise");

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
    const plugin = optionsPlugin.rolldown({
      compatibilityFlags: ["nodejs_compat"],
    });
    const input = {};
    assert(typeof plugin.options === "function", "plugin.options is not a function");
    const output = plugin.options!.call({} as MinimalPluginContext, input);
    assert(output, "output is not defined");
    assert(!(output instanceof Promise), "output is a promise");

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
    const withNavigator = optionsPlugin.rolldown({
      compatibilityDate: "2022-03-21",
    });
    const withoutNavigator = optionsPlugin.rolldown({
      compatibilityDate: "2022-03-20",
    });

    assert(typeof withNavigator.options === "function", "withNavigator.options is not a function");
    assert(
      typeof withoutNavigator.options === "function",
      "withoutNavigator.options is not a function",
    );

    const withNavigatorOutput = withNavigator.options!.call({} as MinimalPluginContext, {});
    const withoutNavigatorOutput = withoutNavigator.options.call({} as MinimalPluginContext, {});

    assert(withNavigatorOutput, "withNavigatorOutput is not defined");
    assert(!(withNavigatorOutput instanceof Promise), "withNavigatorOutput is a promise");
    assert(withoutNavigatorOutput, "withoutNavigatorOutput is not defined");
    assert(!(withoutNavigatorOutput instanceof Promise), "withoutNavigatorOutput is a promise");

    expect(withNavigatorOutput.transform?.define?.["navigator.userAgent"]).toBe(
      '"Cloudflare-Workers"',
    );
    expect(withoutNavigatorOutput.transform?.define?.["navigator.userAgent"]).toBeUndefined();
  });
});
