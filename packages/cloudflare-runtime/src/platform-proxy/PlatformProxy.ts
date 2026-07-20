/**
 * Node-side platform proxy: our reimplementation of wrangler's
 * `getPlatformProxy()` semantics on top of `cloudflare-runtime`.
 *
 * {@link open} starts a workerd instance hosting the requested bindings behind
 * the internal proxy worker and returns Node-side proxies:
 *
 * - `env` — every binding callable from Node. Plain values (`Text`, `Json`,
 *   `Data`) are materialised eagerly; everything else is a lazy stub that
 *   forwards method chains to the worker (`env.KV.get("key")`,
 *   `env.DO.get(env.DO.idFromName("a")).increment()`,
 *   `env.DB.prepare("...").all()`). `fetch()` calls on stubs (service
 *   bindings, Durable Object stubs) stream through a raw HTTP passthrough.
 * - `cf` — a frozen mock of `request.cf` (same shape miniflare falls back to).
 * - `ctx` — an `ExecutionContext` mock whose methods are no-ops (matching
 *   wrangler's `getPlatformProxy().ctx` contract, including the
 *   "Illegal invocation" guard).
 * - `caches` — a functional Cache API proxy backed by an in-memory store in
 *   the proxy worker (unlike wrangler, whose `caches` is a no-op,
 *   `put`/`match`/`delete` actually round-trip).
 *
 * Known limitations (documented deviations from wrangler's magic proxy):
 *
 * - Synchronous materialisation of intermediate values is not supported:
 *   `env.DO.idFromName("a").toString()` cannot resolve synchronously (await
 *   the id first: `(await env.DO.idFromName("a")).toString()`); awaiting an
 *   intermediate stub (e.g. a Durable Object stub) throws a descriptive
 *   error.
 * - Method results must be JSON-compatible values, bytes, dates, streams, or
 *   `DurableObjectId`s. Bindings whose clients return rich class instances
 *   (e.g. `R2Object`) are not yet supported over the proxy.
 * - `newUniqueId()` works (it round-trips as a materialised id), but
 *   `connect()` on sockets is not supported.
 * - Arguments may reference stubs of the same binding (e.g.
 *   `env.DB.batch([env.DB.prepare("...")])`); cross-binding stub arguments
 *   are rejected.
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as ProxyWorker from "worker:./PlatformProxy.worker.ts";
import * as Text from "../bindings/Text.ts";
import type { BindingHook } from "../PluginContext.ts";
import * as Runtime from "../Runtime.ts";
import { ConfigError, type RuntimeError, SystemError } from "../RuntimeError.shared.ts";
import type {
  BindingHooks,
  DurableObjectNamespace,
  Module,
  WorkerdLogging,
} from "../RuntimeWorker.ts";
import type {
  CallRequest,
  EncodedChainSegment,
  EncodedValue,
  EnvDescriptor,
} from "./PlatformProxyProtocol.shared.ts";
import {
  BINDING_PLATFORM_PROXY_TOKEN,
  decodeValue,
  encodeValue,
  HEADER_BINDING,
  HEADER_BYTES_KIND,
  HEADER_CACHE_HEADERS,
  HEADER_CACHE_IGNORE_METHOD,
  HEADER_CACHE_METHOD,
  HEADER_CACHE_NAME,
  HEADER_CACHE_STATUS,
  HEADER_CACHE_URL,
  HEADER_CHAIN,
  HEADER_RESULT,
  HEADER_TOKEN,
  HEADER_URL,
  PATH_CACHE_DELETE,
  PATH_CACHE_MATCH,
  PATH_CACHE_PUT,
  PATH_CALL,
  PATH_ENV,
  PATH_FETCH,
} from "./PlatformProxyProtocol.shared.ts";

const DEFAULT_COMPATIBILITY_DATE = "2026-03-10";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlatformProxyOptions<B extends BindingHooks = BindingHooks> {
  /**
   * Name of the workerd service hosting the proxy (also seeds the default
   * Durable Object unique keys, so keep it stable if you persist DO state).
   * @default "platform-proxy"
   */
  readonly name?: string;
  /** @default "2026-03-10" */
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: Array<string>;
  /**
   * Bindings to expose on `env` — the same hook shapes `Runtime.start`
   * accepts (`Text.local`, `Json.local`, `KvNamespace.local`,
   * `DurableObjectNamespace.local`, `Service.local`, remote bindings, …).
   */
  readonly bindings: B;
  /**
   * Extra modules hosted alongside the proxy worker. Required when binding
   * Durable Objects: the first module must export every configured
   * `durableObjectNamespaces` class.
   */
  readonly modules?: ReadonlyArray<Module>;
  /** Durable Object namespaces implemented by `modules`. */
  readonly durableObjectNamespaces?: ReadonlyArray<DurableObjectNamespace>;
  readonly logging?: WorkerdLogging;
}

export interface PlatformProxyInstance<Env = Record<string, unknown>> {
  /** Environment object containing the requested bindings. */
  readonly env: Env;
  /** Mock of the `request.cf` object (deep-frozen). */
  readonly cf: CfProperties;
  /** Mock of the Workers `ExecutionContext`; all methods are no-ops. */
  readonly ctx: ExecutionContext;
  /** Cache API proxy backed by the workerd instance. */
  readonly caches: PlatformProxyCacheStorage;
  /** Base URL of the proxy worker (mainly for debugging). */
  readonly url: URL;
}

export type CfProperties = Record<string, unknown>;

export interface PlatformProxyCacheStorage {
  readonly default: PlatformProxyCache;
  readonly open: (cacheName: string) => Promise<PlatformProxyCache>;
}

export interface PlatformProxyCache {
  readonly match: (
    request: CacheRequestLike,
    options?: CacheQueryOptions,
  ) => Promise<Response | undefined>;
  readonly put: (request: CacheRequestLike, response: CacheResponseLike) => Promise<void>;
  readonly delete: (request: CacheRequestLike, options?: CacheQueryOptions) => Promise<boolean>;
}

export type CacheRequestLike = string | URL | { url: string; method?: string };

export interface CacheResponseLike {
  readonly status: number;
  readonly headers: Iterable<[string, string]>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface CacheQueryOptions {
  readonly ignoreMethod?: boolean;
}

/**
 * Mock of the `ExecutionContext` Workers hand to their request handlers.
 * All methods are no-ops; detached invocation throws "Illegal invocation",
 * matching both the runtime and wrangler's `getPlatformProxy`.
 */
export class ExecutionContext {
  waitUntil(_promise: Promise<unknown>): void {
    if (!(this instanceof ExecutionContext)) {
      throw new Error("Illegal invocation");
    }
  }
  passThroughOnException(): void {
    if (!(this instanceof ExecutionContext)) {
      throw new Error("Illegal invocation");
    }
  }
  props: Record<string, unknown> = {};
}

// ---------------------------------------------------------------------------
// Proxy client
// ---------------------------------------------------------------------------

interface ProxyClient {
  readonly url: URL;
  readonly token: string;
}

interface ChainSegment {
  readonly method: string;
  readonly args: Array<unknown>;
}

interface ChainRef {
  readonly binding: string;
  readonly chain: Array<ChainSegment>;
}

const CHAIN = Symbol.for("cloudflare-runtime/platform-proxy/chain");
const DURABLE_OBJECT_ID = Symbol.for("cloudflare-runtime/platform-proxy/durable-object-id");

interface MaterializedDurableObjectId {
  readonly [DURABLE_OBJECT_ID]: true;
  readonly name: string | undefined;
  readonly toString: () => string;
  readonly equals: (other: unknown) => boolean;
}

const makeDurableObjectId = (id: string, name?: string): MaterializedDurableObjectId => ({
  [DURABLE_OBJECT_ID]: true,
  name,
  toString: () => id,
  equals: (other: unknown) => String(other) === id,
});

const getChainRef = (value: unknown): ChainRef | undefined =>
  typeof value === "function" || (typeof value === "object" && value !== null)
    ? ((value as Record<PropertyKey, unknown>)[CHAIN] as ChainRef | undefined)
    : undefined;

const isMaterializedId = (value: unknown): value is MaterializedDurableObjectId =>
  typeof value === "object" && value !== null && DURABLE_OBJECT_ID in value;

const encodeNodeValue = (value: unknown): EncodedValue | undefined => {
  if (isMaterializedId(value)) {
    const name = value.name;
    return {
      $: "durable-object-id",
      id: value.toString(),
      ...(name !== undefined ? { name } : {}),
    };
  }
  return undefined;
};

const encodeArg = (binding: string, value: unknown): EncodedValue => {
  const ref = getChainRef(value);
  if (ref !== undefined) {
    if (ref.binding !== binding) {
      throw new Error(
        `platform-proxy: cannot pass a stub of binding "${ref.binding}" to a call on binding "${binding}". ` +
          "Cross-binding stub arguments are not supported.",
      );
    }
    return { $: "chain", chain: encodeChain(binding, ref.chain) };
  }
  return encodeValue(value, encodeNodeValue);
};

const encodeChain = (
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
): Array<EncodedChainSegment> =>
  chain.map((segment) => ({
    method: segment.method,
    args: segment.args.map((arg) => encodeArg(binding, arg)),
  }));

const decodeNodeValue = (encoded: EncodedValue): { readonly value: unknown } | undefined => {
  if (encoded.$ === "durable-object-id") {
    return { value: makeDurableObjectId(encoded.id, encoded.name) };
  }
  return undefined;
};

const decodeCallError = async (response: Response): Promise<Error> => {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: EncodedValue }
    | undefined;
  if (body?.error !== undefined) {
    const decoded = decodeValue(body.error, decodeNodeValue);
    if (decoded instanceof Error) return decoded;
    return new Error(String(decoded));
  }
  return new Error(`platform-proxy: request failed with status ${response.status}`);
};

const callBinding = async (
  client: ProxyClient,
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
): Promise<unknown> => {
  const request: CallRequest = { binding, chain: encodeChain(binding, chain) };
  const response = await fetch(new URL(PATH_CALL, client.url), {
    method: "POST",
    headers: {
      [HEADER_TOKEN]: client.token,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const kind = response.headers.get(HEADER_RESULT);
  switch (kind) {
    case "json": {
      const { value } = (await response.json()) as { value: EncodedValue };
      return decodeValue(value, decodeNodeValue);
    }
    case "bytes": {
      const buffer = await response.arrayBuffer();
      return response.headers.get(HEADER_BYTES_KIND) === "arraybuffer"
        ? buffer
        : new Uint8Array(buffer);
    }
    case "stream":
      return response.body;
    case "error":
      throw await decodeCallError(response);
    default:
      throw new Error(
        `platform-proxy: unexpected response (${response.status}) from the proxy worker`,
      );
  }
};

const passthroughFetch = async (
  client: ProxyClient,
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const request =
    typeof input === "string"
      ? new Request(input, init)
      : input instanceof URL
        ? new Request(input.toString(), init)
        : new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set(HEADER_TOKEN, client.token);
  headers.set(HEADER_BINDING, binding);
  headers.set(HEADER_URL, request.url);
  if (chain.length > 0) {
    headers.set(HEADER_CHAIN, encodeURIComponent(JSON.stringify(encodeChain(binding, chain))));
  }
  return await fetch(new URL(PATH_FETCH, client.url), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    // Required by undici when forwarding a streaming body.
    ...(request.body !== null ? { duplex: "half" } : {}),
  } as RequestInit);
};

const stubDescription = (binding: string, chain: ReadonlyArray<ChainSegment>): string =>
  `[platform-proxy stub ${binding}${chain.map((segment) => `.${segment.method}(…)`).join("")}]`;

/**
 * A lazy expression-tree proxy: property accesses build up a method chain,
 * awaiting the proxy sends the whole chain to the worker in one request.
 */
const makeStub = (client: ProxyClient, binding: string, chain: Array<ChainSegment>): unknown => {
  let memo: Promise<unknown> | undefined;
  const run = () => (memo ??= callBinding(client, binding, chain));
  // A plain-object target: `typeof stub` must not be "function", otherwise
  // consumers (and test matchers) treat awaited stubs as callables.
  const target: Record<PropertyKey, unknown> = {
    [CHAIN]: { binding, chain } satisfies ChainRef,
  };
  return new Proxy(target, {
    get(object, property) {
      if (property === CHAIN) return object[CHAIN];
      if (property === "then") {
        // The binding root itself is not thenable; call results are.
        if (chain.length === 0) return undefined;
        const promise = run();
        return promise.then.bind(promise);
      }
      if (chain.length > 0 && (property === "catch" || property === "finally")) {
        const promise = run();
        return (promise[property] as (...args: Array<unknown>) => unknown).bind(promise);
      }
      if (property === "fetch") {
        return (input: string | URL | Request, init?: RequestInit) =>
          passthroughFetch(client, binding, chain, input, init);
      }
      if (property === "connect") {
        return () => {
          throw new Error("platform-proxy: connect() is not supported over the platform proxy.");
        };
      }
      if (property === "toString" || property === Symbol.toPrimitive) {
        return () => stubDescription(binding, chain);
      }
      if (typeof property !== "string" || property === "toJSON") {
        return undefined;
      }
      return (...args: Array<unknown>) =>
        makeStub(client, binding, [...chain, { method: property, args }]);
    },
  });
};

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const normalizeCacheRequest = (request: CacheRequestLike): { url: string; method: string } => {
  if (typeof request === "string") return { url: request, method: "GET" };
  if (request instanceof URL) return { url: request.toString(), method: "GET" };
  return { url: request.url, method: request.method ?? "GET" };
};

const makeCache = (client: ProxyClient, cacheName: string): PlatformProxyCache => {
  const baseHeaders = (request: CacheRequestLike, options?: CacheQueryOptions) => {
    const { url, method } = normalizeCacheRequest(request);
    return {
      [HEADER_TOKEN]: client.token,
      [HEADER_CACHE_NAME]: cacheName,
      [HEADER_CACHE_URL]: url,
      [HEADER_CACHE_METHOD]: method,
      [HEADER_CACHE_IGNORE_METHOD]: options?.ignoreMethod === true ? "true" : "false",
    };
  };
  const rethrow = async (response: Response): Promise<never> => {
    throw await decodeCallError(response);
  };
  return {
    match: async (request, options) => {
      const response = await fetch(new URL(PATH_CACHE_MATCH, client.url), {
        method: "POST",
        headers: baseHeaders(request, options),
      });
      if (response.status === 204) return undefined;
      if (!response.ok) return rethrow(response);
      const status = parseInt(response.headers.get(HEADER_CACHE_STATUS) ?? "200");
      const headers = new Headers(
        JSON.parse(
          decodeURIComponent(response.headers.get(HEADER_CACHE_HEADERS) ?? "%5B%5D"),
        ) as Array<[string, string]>,
      );
      headers.set("cf-cache-status", "HIT");
      return new Response(await response.arrayBuffer(), { status, headers });
    },
    put: async (request, response) => {
      const body = await response.arrayBuffer();
      const result = await fetch(new URL(PATH_CACHE_PUT, client.url), {
        method: "POST",
        headers: {
          ...baseHeaders(request),
          [HEADER_CACHE_STATUS]: response.status.toString(),
          [HEADER_CACHE_HEADERS]: encodeURIComponent(JSON.stringify([...response.headers])),
        },
        body,
      });
      if (!result.ok) return rethrow(result);
    },
    delete: async (request, options) => {
      const response = await fetch(new URL(PATH_CACHE_DELETE, client.url), {
        method: "POST",
        headers: baseHeaders(request, options),
      });
      if (!response.ok) return rethrow(response);
      return (await response.json()) as boolean;
    },
  };
};

const makeCacheStorage = (client: ProxyClient): PlatformProxyCacheStorage => {
  const defaultCache = makeCache(client, "default");
  return {
    default: defaultCache,
    open: (cacheName: string) => {
      if (cacheName === "default") {
        return Promise.reject(
          new TypeError('"default" is a reserved cache name. Use `caches.default` instead.'),
        );
      }
      return Promise.resolve(makeCache(client, `named:${cacheName}`));
    },
  };
};

// ---------------------------------------------------------------------------
// cf mock
// ---------------------------------------------------------------------------

const deepFreeze = (value: Record<string, unknown>): void => {
  Object.freeze(value);
  for (const property of Object.values(value)) {
    if (property !== null && typeof property === "object" && !Object.isFrozen(property)) {
      deepFreeze(property as Record<string, unknown>);
    }
  }
};

/**
 * Static mock of `request.cf`, mirroring the fallback object miniflare uses
 * when it cannot fetch real values.
 */
const makeCf = (): CfProperties => {
  const cf: CfProperties = {
    asOrganization: "",
    asn: 395747,
    colo: "DFW",
    city: "Austin",
    region: "Texas",
    regionCode: "TX",
    metroCode: "635",
    postalCode: "78701",
    country: "US",
    continent: "NA",
    timezone: "America/Chicago",
    latitude: "30.27130",
    longitude: "-97.74260",
    clientTcpRtt: 0,
    httpProtocol: "HTTP/1.1",
    requestPriority: "weight=192;exclusive=0",
    tlsCipher: "AEAD-AES128-GCM-SHA256",
    tlsVersion: "TLSv1.3",
    tlsClientAuth: {
      certPresented: "0",
      certVerified: "NONE",
      certRevoked: "0",
      certIssuerDN: "",
      certSubjectDN: "",
      certIssuerDNRFC2253: "",
      certSubjectDNRFC2253: "",
      certIssuerDNLegacy: "",
      certSubjectDNLegacy: "",
      certSerial: "",
      certIssuerSerial: "",
      certSKI: "",
      certIssuerSKI: "",
      certFingerprintSHA1: "",
      certFingerprintSHA256: "",
      certNotBefore: "",
      certNotAfter: "",
    },
    edgeRequestKeepAliveStatus: 0,
    hostMetadata: undefined,
    clientTrustScore: 99,
    botManagement: {
      corporateProxy: false,
      verifiedBot: false,
      ja3Hash: "25b4882c2bcb50cd6b469ff28c596742",
      staticResource: false,
      detectionIds: [],
      score: 99,
    },
  };
  deepFreeze(cf);
  return cf;
};

// ---------------------------------------------------------------------------
// Env construction
// ---------------------------------------------------------------------------

const buildEnv = (client: ProxyClient, descriptor: EnvDescriptor): Record<string, unknown> => {
  const env: Record<string, unknown> = {};
  for (const binding of descriptor.bindings) {
    env[binding.name] =
      binding.kind === "value"
        ? decodeValue(binding.value, decodeNodeValue)
        : makeStub(client, binding.name, []);
  }
  return env;
};

// ---------------------------------------------------------------------------
// Worker assembly
// ---------------------------------------------------------------------------

const makeModules = Effect.fnUntraced(function* (options: PlatformProxyOptions) {
  const proxyWorker = yield* Effect.promise(ProxyWorker.worker);
  const userModules = options.modules ?? [];
  const classNames = (options.durableObjectNamespaces ?? []).map(
    (namespace) => namespace.className,
  );
  const userEntry = userModules[0]?.name;
  if (classNames.length > 0 && userEntry === undefined) {
    return yield* new ConfigError({
      subtag: "PlatformProxyMissingModules",
      message: "Durable Object namespaces were configured without any modules.",
      hint: "Pass `modules` whose first module exports every configured Durable Object class.",
      detail: { classNames },
    });
  }
  const entry = [
    `export { default } from "./${proxyWorker.main}";`,
    ...(classNames.length > 0 && userEntry !== undefined
      ? [`export { ${classNames.join(", ")} } from "./${userEntry}";`]
      : []),
  ].join("\n");
  const modules: Array<Module> = [
    { name: "__platform_proxy_entry__.mjs", type: "ESModule", content: entry },
    ...Object.entries(proxyWorker.modules).map(
      ([name, content]): Module => ({ name, type: "ESModule", content }),
    ),
    ...userModules,
  ];
  return modules;
});

const fetchEnvDescriptor = (client: ProxyClient) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(new URL(PATH_ENV, client.url), {
        headers: { [HEADER_TOKEN]: client.token },
      });
      if (!response.ok) {
        throw new Error(`platform-proxy: /env request failed with status ${response.status}`);
      }
      return (await response.json()) as EnvDescriptor;
    },
    catch: (cause) =>
      new SystemError({
        subtag: "PlatformProxyEnvDescriptor",
        message: "Failed to read the environment descriptor from the platform-proxy worker.",
        cause,
      }),
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 10 }));

type BindingRequirements<B extends BindingHooks> =
  B extends Array<never> ? never : B extends ReadonlyArray<BindingHook<infer R>> ? R : never;

/**
 * Start a workerd instance hosting `options.bindings` and return Node-side
 * proxies (`env`, `cf`, `ctx`, `caches`). The instance is torn down when the
 * surrounding `Scope` closes; use {@link ./getPlatformProxy.ts} for the
 * Promise-based convenience wrapper with an explicit `dispose()`.
 */
export const open = Effect.fn("PlatformProxy.open")(function* <
  B extends BindingHooks,
  Env = Record<string, unknown>,
>(options: PlatformProxyOptions<B>) {
  const runtime = yield* Runtime.Runtime;
  const token = crypto.randomUUID();
  const modules = yield* makeModules(options as PlatformProxyOptions);
  const url = yield* runtime.start({
    name: options.name ?? "platform-proxy",
    compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: options.compatibilityFlags ?? [],
    bindings: [
      Text.local(BINDING_PLATFORM_PROXY_TOKEN, token),
      ...options.bindings,
    ] as unknown as B,
    modules,
    durableObjectNamespaces: options.durableObjectNamespaces,
    logging: options.logging,
  });
  const client: ProxyClient = { url, token };
  const descriptor = yield* fetchEnvDescriptor(client);
  const instance: PlatformProxyInstance<Env> = {
    env: buildEnv(client, descriptor) as Env,
    cf: makeCf(),
    ctx: new ExecutionContext(),
    caches: makeCacheStorage(client),
    url,
  };
  return instance;
}) as <B extends BindingHooks, Env = Record<string, unknown>>(
  options: PlatformProxyOptions<B>,
) => Effect.Effect<
  PlatformProxyInstance<Env>,
  RuntimeError,
  Runtime.Runtime | Scope.Scope | BindingRequirements<B>
>;
