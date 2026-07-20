/** Incremental probe: find where boot hangs. */
console.log("[probe] start");
import * as Runtime from "@distilled.cloud/cloudflare-runtime/Runtime";
import * as RuntimeServices from "@distilled.cloud/cloudflare-runtime/RuntimeServices";
import * as Text from "@distilled.cloud/cloudflare-runtime/bindings/Text";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

console.log("[probe] imports done");
process.env.CLOUDFLARE_API_TOKEN ??= "spike-dummy-token";

const layer = RuntimeServices.layerRuntime({
  api: { accountId: "spike-dummy-account" },
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
);
console.log("[probe] layer composed");

const program = Effect.gen(function* () {
  console.log("[probe] layer built, program running");
  const runtime = yield* Runtime.Runtime;
  console.log("[probe] got Runtime service");
  const url = yield* runtime.start({
    name: "spike-probe",
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    bindings: [Text.local("A", "b")],
    modules: [
      {
        name: "index.js",
        type: "ESModule",
        content: "export default { fetch: () => new Response('probe-ok') }",
      },
    ],
  });
  console.log("[probe] started at", url.href);
  const res = yield* Effect.promise(() => fetch(url));
  console.log("[probe] fetch:", res.status, yield* Effect.promise(() => res.text()));
});

await program.pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise);
console.log("[probe] done");
process.exit(0);
