import { describe, expect, it } from "@effect/vitest";
import { RemoteProxyWorker } from "../../src/proxy/RemoteProxy.ts";

describe("RemoteProxy", () => {
  it("re-exports the bundled remote-proxy worker modules", () => {
    expect(RemoteProxyWorker.modules).toBeInstanceOf(Array);
    expect(RemoteProxyWorker.modules.length).toBeGreaterThan(0);
    expect(RemoteProxyWorker.modules[0]).toMatchObject({
      name: expect.any(String),
      type: "ESModule",
      content: expect.any(String),
    });
  });
});
