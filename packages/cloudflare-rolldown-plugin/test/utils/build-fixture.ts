import path from "node:path";
import type {
  InputOptions,
  OutputChunk,
  OutputOptions,
  RolldownOutput,
  RolldownPluginOption,
} from "rolldown";
import { rolldown } from "rolldown";
import type { CloudflarePluginOptions } from "../../src/options.js";
import cloudflare from "../../src/plugin.js";
import { getEntryChunk } from "./output.js";

const DEFAULT_PLUGIN_OPTIONS: CloudflarePluginOptions = {
  compatibilityDate: "2025-07-01",
};

interface BuildFixtureOptions {
  fixture: string;
  pluginOptions?: CloudflarePluginOptions;
  plugins?: Array<RolldownPluginOption>;
  inputOptions?: Omit<InputOptions, "input" | "plugins">;
  outputOptions?: Omit<OutputOptions, "dir">;
}

export interface BuiltFixture {
  fixture: string;
  output: RolldownOutput;
  entry: OutputChunk;
}

export async function buildFixture(options: BuildFixtureOptions): Promise<BuiltFixture> {
  const fixture = normalizeFixturePath(options.fixture);
  const bundle = await rolldown({
    input: fixture,
    plugins: [
      ...(options.plugins ?? []),
      cloudflare(options.pluginOptions ?? DEFAULT_PLUGIN_OPTIONS),
    ],
    ...options.inputOptions,
  });

  try {
    const output = await bundle.write({
      dir: path.join(
        "out",
        path.basename(options.fixture) === "index.ts"
          ? path.dirname(options.fixture)
          : options.fixture,
      ),
      ...options.outputOptions,
    });
    return {
      fixture,
      output,
      entry: getEntryChunk(output),
    };
  } finally {
    await bundle.close();
  }
}

function normalizeFixturePath(fixture: string): string {
  return path.isAbsolute(fixture) ? fixture : path.join("test", "fixtures", fixture);
}
