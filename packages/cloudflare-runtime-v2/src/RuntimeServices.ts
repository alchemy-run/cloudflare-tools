import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Assets from "./assets/Assets.ts";
import * as Runtime from "./Runtime.ts";
import * as Workerd from "./workerd/Workerd.ts";

export const layer = Layer.provide(Runtime.RuntimeLive, Workerd.WorkerdLive).pipe(
  Layer.provideMerge(Assets.AssetsLive),
);

await Effect.gen(function* () {
  const runtime = yield* Runtime.Runtime;
  const result = yield* runtime.start({
    name: "test",
    compatibilityDate: "2026-01-01",
    compatibilityFlags: [],
    bindings: [Assets.binding("assets")],
    modules: [
      {
        name: "test.js",
        type: "ESModule",
        content: "export default { fetch: () => new Response('Hello, world!') };",
      },
    ],
    assets: {
      directory: "node_modules",
    },
  });
  yield* Effect.sleep(1000);
  return result;
}).pipe(
  Effect.provide(layer),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.runPromise,
);
