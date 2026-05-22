import { describe, expect, it } from "vitest";
import { kVoid } from "../src/workerd/Config.ts";
import { serializeConfig } from "../src/workerd/internal/config.serialize.ts";

describe("serializeConfig", () => {
  it("serializes a minimal valid config", () => {
    const buffer = serializeConfig({
      sockets: [
        {
          name: "http",
          address: "127.0.0.1:0",
          service: { name: "user" },
        },
      ],
      services: [
        {
          name: "user",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: [
              {
                name: "main.js",
                esModule: "export default { fetch: () => new Response('ok') };",
              },
            ],
          },
        },
      ],
    });
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it("encodes void bindings using kVoid", () => {
    expect(() =>
      serializeConfig({
        services: [
          {
            name: "user",
            worker: {
              modules: [{ name: "main.js", esModule: "export default {}" }],
              bindings: [{ name: "EVAL", unsafeEval: kVoid }],
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("throws a useful error when a `json` binding is given an object instead of a string", () => {
    expect(() =>
      serializeConfig({
        services: [
          {
            name: "user",
            worker: {
              modules: [{ name: "main.js", esModule: "export default {}" }],
              bindings: [
                {
                  name: "CONFIG",
                  // BUG: this should be JSON.stringify(...). The serializer
                  // must surface a helpful error rather than the cryptic
                  // `anyStruct[capitalized] is not a function`.
                  json: { foo: "bar" } as unknown as string,
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/services\.0\.worker\.bindings\.0\.json/);
  });

  it("throws a useful error when a key does not exist on the capnp struct", () => {
    expect(() =>
      serializeConfig({
        services: [
          {
            name: "user",
            worker: {
              modules: [{ name: "main.js", esModule: "export default {}" }],
              // @ts-expect-error - intentionally invalid key
              bindings: [{ name: "X", notARealField: "value" }],
            },
          },
        ],
      }),
    ).toThrow(/notARealField|NotARealField/);
  });
});
