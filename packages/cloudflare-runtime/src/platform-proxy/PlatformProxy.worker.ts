/**
 * The platform-proxy worker: runs as the user-worker service inside workerd
 * with the caller's bindings attached, and exposes them to Node over HTTP.
 * See {@link ./PlatformProxyProtocol.shared.ts} for the protocol.
 */
/** The request type `ExportedHandler["fetch"]` receives (ambient workers-types globals). */
type WorkerRequest = Request<unknown, IncomingRequestCfProperties<unknown>>;
import type {
  CallRequest,
  EncodedChainSegment,
  EncodedValue,
  EnvBindingDescriptor,
  ResultKind,
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

interface Env {
  [binding: string]: unknown;
}

class ProxyRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const isTimingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
};

const assertAuthorized = (request: WorkerRequest, env: Env) => {
  const token = request.headers.get(HEADER_TOKEN);
  const expected = env[BINDING_PLATFORM_PROXY_TOKEN];
  if (typeof expected !== "string" || !token || !isTimingSafeEqual(token, expected)) {
    throw new ProxyRequestError("platform-proxy: authorization failed", 401);
  }
};

// ---------------------------------------------------------------------------
// Env descriptor
// ---------------------------------------------------------------------------

const isPlainValue = (value: unknown): boolean => {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object": {
      if (value === null) return true;
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
      if (Array.isArray(value)) return value.every(isPlainValue);
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        return Object.values(value).every(isPlainValue);
      }
      return false;
    }
    default:
      return false;
  }
};

const describeEnv = (env: Env): { bindings: Array<EnvBindingDescriptor> } => {
  const bindings: Array<EnvBindingDescriptor> = [];
  for (const [name, value] of Object.entries(env)) {
    if (name === BINDING_PLATFORM_PROXY_TOKEN) continue;
    if (isPlainValue(value)) {
      bindings.push({ name, kind: "value", value: encodeValue(value) });
    } else {
      const className = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
      bindings.push({ name, kind: "stub", ...(className !== undefined ? { className } : {}) });
    }
  }
  return { bindings };
};

// ---------------------------------------------------------------------------
// Chain evaluation (`/call` and the target resolution of `/fetch`)
// ---------------------------------------------------------------------------

const encodeWorkerValue = (value: unknown): EncodedValue | undefined => {
  if (
    typeof value === "object" &&
    value !== null &&
    value.constructor?.name === "DurableObjectId"
  ) {
    const id = value as DurableObjectId;
    return { $: "durable-object-id", id: id.toString(), ...(id.name ? { name: id.name } : {}) };
  }
  return undefined;
};

const decodeArg = async (env: Env, binding: string, arg: EncodedValue): Promise<unknown> => {
  if (arg.$ === "chain") {
    return evaluateChain(env, binding, arg.chain);
  }
  if (arg.$ === "durable-object-id") {
    const namespace = env[binding] as DurableObjectNamespace | undefined;
    if (typeof namespace?.idFromString !== "function") {
      throw new ProxyRequestError(
        `platform-proxy: binding "${binding}" cannot rehydrate a DurableObjectId (no idFromString).`,
      );
    }
    return namespace.idFromString(arg.id);
  }
  return decodeValue(arg);
};

const evaluateChain = async (
  env: Env,
  binding: string,
  chain: Array<EncodedChainSegment>,
): Promise<unknown> => {
  let target: unknown = env[binding];
  if (target === undefined) {
    throw new ProxyRequestError(`platform-proxy: binding "${binding}" not found`, 404);
  }
  let path = binding;
  for (const segment of chain) {
    const args = await Promise.all(segment.args.map((arg) => decodeArg(env, binding, arg)));
    const method = (target as Record<string, unknown> | null)?.[segment.method];
    if (typeof method !== "function") {
      const targetObject = target as object | null;
      const available =
        targetObject === null
          ? []
          : [
              ...Object.getOwnPropertyNames(targetObject),
              ...Object.getOwnPropertyNames(Object.getPrototypeOf(targetObject) ?? {}),
            ];
      throw new ProxyRequestError(
        `platform-proxy: "${segment.method}" is not a method on \`${path}\` ` +
          `(${(targetObject as { constructor?: { name?: string } })?.constructor?.name ?? typeof target}; available: ${available.join(", ")})`,
      );
    }
    // Reflect.apply (never `method.apply`): property access on workers RPC
    // method stubs turns "apply" into an RPC path segment instead of calling.
    target = await Reflect.apply(method as (...args: Array<unknown>) => unknown, target, args);
    path += `.${segment.method}(…)`;
  }
  return target;
};

const resultHeaders = (kind: ResultKind, extra?: Record<string, string>) => ({
  [HEADER_RESULT]: kind,
  ...extra,
});

const encodeResult = (result: unknown): Response => {
  if (result instanceof ReadableStream) {
    return new Response(result, { headers: resultHeaders("stream") });
  }
  if (result instanceof ArrayBuffer) {
    return new Response(result, {
      headers: resultHeaders("bytes", { [HEADER_BYTES_KIND]: "arraybuffer" }),
    });
  }
  if (ArrayBuffer.isView(result)) {
    const bytes = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    const kind = result instanceof Uint8Array ? "uint8array" : result.constructor.name;
    return new Response(bytes, {
      headers: resultHeaders("bytes", { [HEADER_BYTES_KIND]: kind }),
    });
  }
  return Response.json(
    { value: encodeValue(result, encodeWorkerValue) },
    { headers: resultHeaders("json") },
  );
};

const handleCall = async (request: WorkerRequest, env: Env): Promise<Response> => {
  const { binding, chain } = (await request.json()) as CallRequest;
  if (typeof binding !== "string" || !Array.isArray(chain)) {
    throw new ProxyRequestError("platform-proxy: malformed /call request body");
  }
  const result = await evaluateChain(env, binding, chain);
  return encodeResult(result);
};

// ---------------------------------------------------------------------------
// Fetch passthrough
// ---------------------------------------------------------------------------

const handleProxyFetch = async (request: WorkerRequest, env: Env): Promise<Response> => {
  const binding = request.headers.get(HEADER_BINDING);
  const targetUrl = request.headers.get(HEADER_URL);
  if (!binding || !targetUrl) {
    throw new ProxyRequestError("platform-proxy: missing binding or target url on /fetch request");
  }
  const chainHeader = request.headers.get(HEADER_CHAIN);
  const chain: Array<EncodedChainSegment> = chainHeader
    ? (JSON.parse(decodeURIComponent(chainHeader)) as Array<EncodedChainSegment>)
    : [];
  const target = (await evaluateChain(env, binding, chain)) as {
    fetch?: (request: Request) => Promise<Response>;
  } | null;
  if (typeof target?.fetch !== "function") {
    throw new ProxyRequestError(
      `platform-proxy: the resolved target on binding "${binding}" has no fetch() method`,
    );
  }
  const headers = new Headers(request.headers);
  for (const header of [HEADER_TOKEN, HEADER_BINDING, HEADER_CHAIN, HEADER_URL]) {
    headers.delete(header);
  }
  const forwarded = new Request(targetUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  return await target.fetch(forwarded);
};

// ---------------------------------------------------------------------------
// Cache emulation
//
// workerd's built-in Cache API is a no-op unless backed by an external cache
// service, so the proxy worker hosts its own in-memory store. Entries live for
// the lifetime of the workerd instance and follow the Workers cache rules that
// matter in dev: GET-only keys, no 206 responses, no `Vary: *`.
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly status: number;
  readonly headers: Array<[string, string]>;
  readonly body: Uint8Array;
}

const cacheStore = new Map<string, Map<string, CacheEntry>>();

const cacheKey = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
};

const getCacheContext = (request: WorkerRequest) => {
  const name = request.headers.get(HEADER_CACHE_NAME);
  const url = request.headers.get(HEADER_CACHE_URL);
  if (name === null || url === null) {
    throw new ProxyRequestError("platform-proxy: missing cache name or url");
  }
  const method = request.headers.get(HEADER_CACHE_METHOD) ?? "GET";
  const ignoreMethod = request.headers.get(HEADER_CACHE_IGNORE_METHOD) === "true";
  return { name, key: cacheKey(url), method: ignoreMethod ? "GET" : method };
};

const handleCacheMatch = (request: WorkerRequest): Response => {
  const { name, key, method } = getCacheContext(request);
  if (method !== "GET") return new Response(null, { status: 204 });
  const entry = cacheStore.get(name)?.get(key);
  if (entry === undefined) return new Response(null, { status: 204 });
  return new Response(entry.body, {
    status: 200,
    headers: {
      [HEADER_CACHE_STATUS]: entry.status.toString(),
      [HEADER_CACHE_HEADERS]: encodeURIComponent(JSON.stringify(entry.headers)),
    },
  });
};

const handleCachePut = async (request: WorkerRequest): Promise<Response> => {
  const { name, key, method } = getCacheContext(request);
  const status = parseInt(request.headers.get(HEADER_CACHE_STATUS) ?? "NaN");
  const rawHeaders = request.headers.get(HEADER_CACHE_HEADERS);
  if (Number.isNaN(status) || rawHeaders === null) {
    throw new ProxyRequestError("platform-proxy: malformed cache put request");
  }
  if (method !== "GET") {
    throw new ProxyRequestError("Cannot cache response to non-GET request.");
  }
  if (status === 206) {
    throw new ProxyRequestError("Cannot cache response to a range request (206 Partial Content).");
  }
  const headers = JSON.parse(decodeURIComponent(rawHeaders)) as Array<[string, string]>;
  const vary = headers.find(([header]) => header.toLowerCase() === "vary");
  if (vary && vary[1].includes("*")) {
    throw new ProxyRequestError("Cannot cache response with 'Vary: *' header.");
  }
  const body = new Uint8Array(await request.arrayBuffer());
  let entries = cacheStore.get(name);
  if (entries === undefined) {
    entries = new Map();
    cacheStore.set(name, entries);
  }
  entries.set(key, { status, headers, body });
  return new Response(null, { status: 204 });
};

const handleCacheDelete = (request: WorkerRequest): Response => {
  const { name, key, method } = getCacheContext(request);
  const deleted = method === "GET" && (cacheStore.get(name)?.delete(key) ?? false);
  return Response.json(deleted);
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: WorkerRequest, env) {
    try {
      assertAuthorized(request, env);
      const url = new URL(request.url);
      switch (url.pathname) {
        case PATH_ENV:
          return Response.json(describeEnv(env));
        case PATH_CALL:
          return await handleCall(request, env);
        case PATH_FETCH:
          return await handleProxyFetch(request, env);
        case PATH_CACHE_MATCH:
          return handleCacheMatch(request);
        case PATH_CACHE_PUT:
          return await handleCachePut(request);
        case PATH_CACHE_DELETE:
          return handleCacheDelete(request);
        default:
          return Response.json(
            { error: `platform-proxy: unknown route ${url.pathname}` },
            { status: 404 },
          );
      }
    } catch (error) {
      const status = error instanceof ProxyRequestError ? error.status : 500;
      const encoded = encodeValue(
        error instanceof Error ? error : new Error(String(error)),
        encodeWorkerValue,
      );
      return Response.json({ error: encoded }, { status, headers: { [HEADER_RESULT]: "error" } });
    }
  },
} satisfies ExportedHandler<Env>;
