import * as Effect from "effect/Effect";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { describe, expect, it } from "vitest";
import { connectPlatformEnv, type ProtocolModule } from "../src/dev/client.ts";
import {
  makeCloudflareDevPlatform,
  recoverProxyToken,
  resolveDevPluginPath,
  resolveProtocolModulePath,
  withUuidCapture,
  type OpenDevProxy,
} from "../src/dev/host.ts";
import { RUNTIME_CONFIG_KEY, type DevConnectInfo } from "../src/dev/shared.ts";
import { fromHarnessOptions } from "../src/index.ts";

// The REAL public protocol module the dev bridge is built on — the same
// import the host resolves for the plugin.
const loadProtocol = (): Promise<ProtocolModule> =>
  import("@distilled.cloud/cloudflare-runtime/platform-proxy/PlatformProxyProtocol");

const listen = (server: NodeHttp.Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      resolve(`http://127.0.0.1:${address.port}/`);
    });
  });

const close = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

describe("withUuidCapture", () => {
  it("captures the uuids handed out during the window and restores the original", async () => {
    const original = crypto.randomUUID;
    const { value, candidates } = await withUuidCapture(async () => {
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      return [first, second];
    });
    expect(crypto.randomUUID).toBe(original);
    expect(candidates).toEqual(value);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("restores the original even when the opener throws", async () => {
    const original = crypto.randomUUID;
    await expect(
      withUuidCapture(async () => {
        crypto.randomUUID();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(crypto.randomUUID).toBe(original);
  });

  it("serializes overlapping capture windows", async () => {
    const original = crypto.randomUUID;
    const [first, second] = await Promise.all([
      withUuidCapture(async () => crypto.randomUUID()),
      withUuidCapture(async () => crypto.randomUUID()),
    ]);
    expect(crypto.randomUUID).toBe(original);
    // Each window observed exactly its own uuid (no cross-talk).
    expect(first.candidates).toEqual([first.value]);
    expect(second.candidates).toEqual([second.value]);
  });
});

describe("recoverProxyToken", () => {
  it("finds the authenticating candidate by probing /env", async () => {
    const protocol = await loadProtocol();
    const token = crypto.randomUUID();
    const server = NodeHttp.createServer((request, response) => {
      const ok =
        request.url === protocol.PATH_ENV && request.headers[protocol.HEADER_TOKEN] === token;
      response.statusCode = ok ? 200 : 401;
      response.end(ok ? JSON.stringify({ bindings: [] }) : "unauthorized");
    });
    const url = await listen(server);
    try {
      const recovered = await recoverProxyToken(
        url,
        [crypto.randomUUID(), token, crypto.randomUUID()],
        protocol,
      );
      expect(recovered).toBe(token);
    } finally {
      await close(server);
    }
  });

  it("fails descriptively when no candidate authenticates", async () => {
    const protocol = await loadProtocol();
    const server = NodeHttp.createServer((_request, response) => {
      response.statusCode = 401;
      response.end("unauthorized");
    });
    const url = await listen(server);
    try {
      await expect(recoverProxyToken(url, [crypto.randomUUID()], protocol)).rejects.toThrow(
        /could not recover the platform-proxy auth token/i,
      );
    } finally {
      await close(server);
    }
  });
});

describe("module resolution", () => {
  it("resolves the shipped dev plugin next to the host module", () => {
    const path = resolveDevPluginPath();
    expect(path).toMatch(/dev[/\\]plugin\.(ts|js)$/);
    expect(NodeFs.existsSync(path)).toBe(true);
  });

  it("resolves the public protocol module from this package's dependencies", () => {
    const path = resolveProtocolModulePath();
    expect(path).toContain("PlatformProxyProtocol");
    expect(NodeFs.existsSync(path)).toBe(true);
  });
});

describe("makeCloudflareDevPlatform", () => {
  it("opens the proxy, injects the plugin + connect info, and disposes with the scope", async () => {
    let disposed = 0;
    let openedWith: Parameters<OpenDevProxy>[0] | undefined;
    const openProxy: OpenDevProxy = async (options) => {
      openedWith = options;
      return {
        url: "http://127.0.0.1:4321/",
        token: "test-token",
        dispose: async () => {
          disposed += 1;
        },
      };
    };
    const bindings = [{ kind: "text" }];
    const platform = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const platform = yield* makeCloudflareDevPlatform({
            openProxy,
            compatibilityDate: "2026-03-10",
            compatibilityFlags: ["nodejs_compat"],
          })({
            root: "/tmp/project",
            env: { LITERAL: "value", SKIPPED: { not: "a string" } },
            bindings,
          });
          // Still alive inside the scope.
          expect(disposed).toBe(0);
          return platform;
        }),
      ),
    );
    expect(disposed).toBe(1);
    expect(openedWith?.name).toBe("nuxt-dev-platform-proxy");
    expect(openedWith?.compatibilityDate).toBe("2026-03-10");
    expect(openedWith?.bindings).toBe(bindings);
    expect(platform.nitroPlugins).toEqual([resolveDevPluginPath()]);
    const info = (platform.runtimeConfig as Record<string, DevConnectInfo>)[RUNTIME_CONFIG_KEY];
    expect(info).toBeDefined();
    expect(info?.url).toBe("http://127.0.0.1:4321/");
    expect(info?.token).toBe("test-token");
    expect(info?.protocolModule).toBe(resolveProtocolModulePath());
    // Literal env: strings only.
    expect(info?.env).toEqual({ LITERAL: "value" });
  });

  it("maps the open failure onto DeployTargetError", async () => {
    const openProxy: OpenDevProxy = async () => {
      throw new Error("workerd exploded");
    };
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(makeCloudflareDevPlatform({ openProxy })({ root: "/tmp/project" })),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const failure = result.failure as { _tag: string; message: string };
      expect(failure._tag).toBe("DeployTargetError");
      expect(failure.message).toContain("Failed to open the dev platform proxy");
    }
  });
});

describe("connectPlatformEnv (protocol client)", () => {
  it("materialises value bindings, overlays literals, and round-trips a stub call", async () => {
    const protocol = await loadProtocol();
    const token = "client-token";
    const store = new Map<string, string>();
    const server = NodeHttp.createServer((request, response) => {
      if (request.headers[protocol.HEADER_TOKEN] !== token) {
        response.statusCode = 401;
        response.end("unauthorized");
        return;
      }
      if (request.url === protocol.PATH_ENV) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            bindings: [
              { name: "TEXT", kind: "value", value: { $: "string", value: "hello" } },
              { name: "OVERRIDDEN", kind: "value", value: { $: "string", value: "proxied" } },
              { name: "KV", kind: "stub" },
            ],
          }),
        );
        return;
      }
      if (request.url === protocol.PATH_CALL) {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
          const call = JSON.parse(body) as {
            binding: string;
            chain: Array<{ method: string; args: Array<{ $: string; value?: unknown }> }>;
          };
          const [segment] = call.chain;
          let result: unknown = null;
          if (segment?.method === "put") {
            store.set(String(segment.args[0]?.value), String(segment.args[1]?.value));
            result = undefined;
          } else if (segment?.method === "get") {
            result = store.get(String(segment.args[0]?.value)) ?? null;
          }
          response.setHeader(protocol.HEADER_RESULT, "json");
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ value: protocol.encodeValue(result) }));
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const url = await listen(server);
    try {
      const info: DevConnectInfo = {
        url,
        token,
        protocolModule: resolveProtocolModulePath(),
        env: { OVERRIDDEN: "literal-wins" },
      };
      const env = await connectPlatformEnv(info, protocol);
      expect(env.TEXT).toBe("hello");
      expect(env.OVERRIDDEN).toBe("literal-wins");
      const kv = env.KV as {
        put: (key: string, value: string) => Promise<void>;
        get: (key: string) => Promise<string | null>;
      };
      await kv.put("k", "v");
      expect(await kv.get("k")).toBe("v");
      expect(await kv.get("missing")).toBeNull();
    } finally {
      await close(server);
    }
  });

  it("fails descriptively when the proxy rejects the token", async () => {
    const protocol = await loadProtocol();
    const server = NodeHttp.createServer((_request, response) => {
      response.statusCode = 401;
      response.end("unauthorized");
    });
    const url = await listen(server);
    try {
      await expect(
        connectPlatformEnv(
          { url, token: "wrong", protocolModule: resolveProtocolModulePath() },
          protocol,
        ),
      ).rejects.toThrow(/\/env request failed with status 401/);
    } finally {
      await close(server);
    }
  });
});

describe("fromHarnessOptions (dev)", () => {
  it("passes the harness worker's binding hooks through to dev.bindings", () => {
    const bindings = [{ hook: true }];
    const options = fromHarnessOptions({
      target: { cloudflare: { worker: { worker: { bindings } } } },
    });
    expect(options.dev?.bindings).toBe(bindings);
  });
});
