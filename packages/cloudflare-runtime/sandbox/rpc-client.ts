import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as ServerRpc from "../src/rpc-server.ts";
import * as Bundle from "../src/utils/bundle.ts";
import { run } from "./layers.ts";

const program = Effect.gen(function* () {
  const client = yield* ServerRpc.client("http://localhost:9000/rpc");
  const modules = yield* Bundle.bundle("sandbox/hello-world.worker.ts").pipe(
    Effect.flatMap(Bundle.bundleOutputToWorkerd),
  );
  const result = yield* client.Serve({
    name: "main",
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    compatibilityDate: "2026-03-10",
    bindings: [
      {
        name: "KV",
        type: "kv_namespace",
        namespaceId: "c2399b3754ea4199a765e8c388eb2603",
      },
    ],
    modules,
  });
  yield* Effect.log("Served worker", result);
});

await run(program.pipe(Effect.scoped));
