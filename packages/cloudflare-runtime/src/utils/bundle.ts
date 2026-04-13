import cloudflare from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Rolldown from "rolldown";

type Output = [Rolldown.OutputChunk, ...Array<Rolldown.OutputChunk | Rolldown.OutputAsset>];

export const bundle = Effect.fn((entry: string) =>
  Effect.promise(async (): Promise<Output> => {
    const bundle = await Rolldown.rolldown({
      input: entry,
      plugins: [cloudflare()],
    });
    const { output } = await bundle.generate({
      file: "worker.js",
      format: "esm",
      minify: false,
    });
    await bundle.close();
    return output;
  }),
);

const transformRolldownOutput = (output: Output) => ({
  name: "worker.js",
  esModule: output[0].code,
});

export const bundleAsEsModule = flow(bundle, Effect.map(transformRolldownOutput));

export const watch = (entry: string) =>
  Stream.callback<Output>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = Rolldown.watch({
          input: entry,
          plugins: [
            cloudflare(),
            {
              name: "alchemy:watch-bundle",
              generateBundle(_outputOptions, bundle) {
                Queue.offerUnsafe(queue, Object.values(bundle) as Output);
              },
            },
          ],
          output: {
            file: "worker.js",
            format: "esm",
            minify: false,
          },
        });
        return watcher;
      }),
      (watcher) => Effect.promise(() => watcher.close()),
    ),
  ).pipe(Stream.map(transformRolldownOutput));
