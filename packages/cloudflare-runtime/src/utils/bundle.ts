import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import { flow } from "effect";
import * as Effect from "effect/Effect";
import { rolldown } from "rolldown";

export const bundle = Effect.fn((entry: string) =>
  Effect.promise(async () => {
    const bundle = await rolldown({
      input: entry,
      plugins: [cloudflare()],
    });
    const output = await bundle.generate({
      file: "worker.js",
      format: "esm",
      minify: false,
    });
    await bundle.close();
    return output;
  }),
);

export const bundleAsEsModule = flow(
  bundle,
  Effect.map(({ output }) => ({
    name: "worker.js",
    esModule: output[0].code,
  })),
);
