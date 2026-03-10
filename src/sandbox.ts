import * as Effect from "effect/Effect";
import * as Esbuild from "./esbuild.js";

const program = Effect.gen(function* () {
  const esbuild = yield* Esbuild.Esbuild;
  const result = yield* esbuild.build({
    stdin: {
      contents: "console.log('Hello, world!);",
      sourcefile: "index.ts",
      loader: "ts",
    },
    outfile: "dist/index.js",
    write: false,
  });
  console.log(result);
});

await Effect.runPromise(program.pipe(Effect.provide(Esbuild.EsbuildLive)));
