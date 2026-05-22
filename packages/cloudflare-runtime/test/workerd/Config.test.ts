import { describe, expect, it } from "@effect/vitest";
import * as WorkerdConfig from "../../src/workerd/Config.ts";
import { serializeConfig } from "../../src/workerd/internal/config.serialize.ts";

describe("workerd/Config", () => {
  it("kVoid is a unique symbol", () => {
    expect(typeof WorkerdConfig.kVoid).toBe("symbol");
    expect(WorkerdConfig.kVoid.description).toBe("kVoid");
  });

  it("serializeConfig produces an ArrayBuffer for a basic worker config", () => {
    const config: WorkerdConfig.Config = {
      sockets: [
        { name: "http", address: "127.0.0.1:0", service: { name: "user" } },
      ],
      services: [
        {
          name: "user",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: [
              {
                name: "main.js",
                esModule: "export default { fetch: () => new Response('hi') };",
              },
            ],
          },
        },
      ],
    };
    const buffer = serializeConfig(config);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it("serializeConfig handles kVoid + Uint8Array fields", () => {
    const config: WorkerdConfig.Config = {
      services: [
        {
          name: "user",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: [
              { name: "data.bin", data: new Uint8Array([1, 2, 3, 4, 5]) },
              { name: "main.js", esModule: "export default {}" },
            ],
            bindings: [
              { name: "EVAL", unsafeEval: WorkerdConfig.kVoid },
            ],
            durableObjectNamespaces: [
              { className: "Foo", ephemeralLocal: WorkerdConfig.kVoid },
            ],
          },
        },
      ],
    };
    const buffer = serializeConfig(config);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });

  it("serializeConfig handles extensions and disk services", () => {
    const config: WorkerdConfig.Config = {
      services: [
        { name: "files", disk: { path: "/tmp", writable: false } },
      ],
      extensions: [
        {
          modules: [
            { name: "ext.js", internal: true, esModule: "export const x = 1;" },
          ],
        },
      ],
    };
    const buffer = serializeConfig(config);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});
