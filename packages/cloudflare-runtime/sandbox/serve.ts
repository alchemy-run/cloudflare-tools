import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { DevClient } from "../src/dev/DevClient.ts";
import { layers } from "./layers.ts";

const program = Effect.gen(function* () {
  console.time("serve");
  const server = yield* DevClient;
  const result = yield* server.serve({
    name: "main",
    accountId: yield* Config.string("CLOUDFLARE_ACCOUNT_ID"),
    compatibilityDate: "2026-03-10",
    compatibilityFlags: ["nodejs_compat"],
    bindings: [
      {
        name: "KV",
        type: "kv_namespace",
        namespaceId: "c2399b3754ea4199a765e8c388eb2603",
      },
    ],
    main: "sandbox/hello-world.worker.ts",
    durableObjectNamespaces: [],
  });
  console.timeEnd("serve");
  console.log(result);
});

Effect.all([program, Effect.never]).pipe(
  Effect.scoped,
  Effect.provide(layers),
  NodeRuntime.runMain,
);
