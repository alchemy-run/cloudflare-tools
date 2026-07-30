/**
 * Dev-only nitro plugin: serves the `cloudflare_module` preset's runtime
 * contract inside nitro's dev SSR worker thread, wrangler-free.
 *
 * Injected by the framework host (`Nuxt.dev()` via the Cloudflare target's
 * dev platform, `./host.ts`) through `overrides.nitro.plugins`; a project
 * running under its own `nuxi dev` never loads it. On every request it sets
 * (the same contract `nitro-cloudflare-dev` provides, and production serves
 * natively):
 *
 * - `event.context.cf` — the static `request.cf` mock;
 * - `event.context.waitUntil` — accepted and dropped (long-lived dev
 *   process: background work simply runs);
 * - `event.context.cloudflare = { request, env, context }` — `env` is the
 *   live proxied environment (bindings round-trip to the host's workerd
 *   instance over HTTP, so state is SHARED with the host proxy), `request`
 *   is a synthesized `Request` carrying `cf`, `context` is the no-op
 *   `ExecutionContext` mock.
 *
 * The connection is established lazily on the first request and re-created
 * after a failure, so a nitro dev reload (worker-thread replacement)
 * reconnects on its own with binding state intact. When the host proxy is
 * gone, requests fail fast with a descriptive cause (ECONNREFUSED) instead
 * of hanging.
 */
import { defineNitroPlugin, useRuntimeConfig } from "nitropack/runtime";
import { pathToFileURL } from "node:url";
import {
  connectPlatformEnv,
  makeCfMock,
  makeExecutionContextMock,
  type ProtocolModule,
} from "./client.ts";
import { RUNTIME_CONFIG_KEY, type DevConnectInfo } from "./shared.ts";

/** The structural slice of the h3 event the bridge touches. */
interface DevEventSlice {
  context: Record<string, unknown>;
  node?: {
    req?: {
      url?: string | undefined;
      method?: string | undefined;
      headers?: Record<string, string | Array<string> | undefined>;
      socket?: { encrypted?: boolean | undefined } | undefined;
    };
  };
}

const isConnectInfo = (value: unknown): value is DevConnectInfo =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as DevConnectInfo).url === "string" &&
  typeof (value as DevConnectInfo).token === "string" &&
  typeof (value as DevConnectInfo).protocolModule === "string";

/**
 * Synthesize the per-event `Request` (what the preset's runtime hands the
 * worker). Body is intentionally omitted: the node request stream belongs
 * to h3's own body parsing — read bodies through h3 (`readBody`), not
 * `context.cloudflare.request`.
 */
const synthesizeRequest = (
  event: DevEventSlice,
  cf: Record<string, unknown>,
): Request | undefined => {
  try {
    const req = event.node?.req;
    if (req === undefined) return undefined;
    const host = (typeof req.headers?.host === "string" && req.headers.host) || "localhost";
    const protocol = req.socket?.encrypted === true ? "https" : "http";
    const url = new URL(req.url ?? "/", `${protocol}://${host}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    }
    const request = new Request(url.toString(), { method: req.method ?? "GET", headers });
    Object.defineProperty(request, "cf", { value: cf, configurable: true });
    return request;
  } catch {
    return undefined;
  }
};

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig() as Record<string, unknown>;
  const info = config[RUNTIME_CONFIG_KEY];
  if (!isConnectInfo(info)) {
    // Not running under the distilled dev host — stay inert.
    return;
  }
  const cf = makeCfMock();
  let connected: Promise<Record<string, unknown>> | undefined;
  const connect = () =>
    (connected ??= (async () => {
      const protocol = (await import(
        /* @vite-ignore */ pathToFileURL(info.protocolModule).href
      )) as ProtocolModule;
      return await connectPlatformEnv(info, protocol);
    })().catch((error: unknown) => {
      // Reset so the next request retries (host proxy restarts, races).
      connected = undefined;
      throw error;
    }));

  nitroApp.hooks.hook("request", async (event) => {
    const slice = event as unknown as DevEventSlice;
    const env = await connect();
    const context = makeExecutionContextMock();
    slice.context.cf = cf;
    slice.context.waitUntil = context.waitUntil;
    slice.context.cloudflare = {
      request: synthesizeRequest(slice, cf),
      env,
      context,
    };
  });
});
