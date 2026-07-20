import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as KvNamespace from "../../src/bindings/KvNamespace.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/roundtrip") {
      await env.KV.put("greeting", "hello-kv", {
        metadata: { source: "test" },
        expirationTtl: 300,
      });
      const value = await env.KV.get("greeting");
      const withMeta = await env.KV.getWithMetadata("greeting");
      const missing = await env.KV.get("missing");
      const list = await env.KV.list({ prefix: "greet" });
      await env.KV.delete("greeting");
      const afterDelete = await env.KV.get("greeting");
      return Response.json({
        value,
        metadata: withMeta.metadata,
        missing,
        keys: list.keys.map((key) => key.name),
        afterDelete,
      });
    }
    if (url.pathname === "/isolation") {
      await env.KV.put("shared-key", "from-KV");
      const other = await env.OTHER.get("shared-key");
      const aliased = await env.ALIAS.get("shared-key");
      return Response.json({ other, aliased });
    }
    return new Response("not found", { status: 404 });
  },
};
`;

layer(localRuntimeLayer)("KvNamespace local binding", (it) => {
  it.effect(
    "supports put/get/getWithMetadata/list/delete from inside a worker",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "kv-local-binding",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [KvNamespace.local("KV")],
          modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
        });
        const result = yield* worker.fetchJson<{
          value: string;
          metadata: { source: string };
          missing: null;
          keys: Array<string>;
          afterDelete: null;
        }>("/roundtrip");
        expect(result.value).toBe("hello-kv");
        expect(result.metadata).toEqual({ source: "test" });
        expect(result.missing).toBeNull();
        expect(result.keys).toEqual(["greeting"]);
        expect(result.afterDelete).toBeNull();
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "isolates namespaces by id and shares data for aliased ids",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "kv-local-isolation",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            KvNamespace.local("KV"),
            KvNamespace.local("OTHER"),
            KvNamespace.local("ALIAS", { namespaceId: "KV" }),
          ],
          modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
        });
        const result = yield* worker.fetchJson<{ other: null; aliased: string }>("/isolation");
        expect(result.other).toBeNull();
        expect(result.aliased).toBe("from-KV");
      }),
    { timeout: 30_000 },
  );
});
