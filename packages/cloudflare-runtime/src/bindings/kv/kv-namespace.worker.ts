/**
 * A minimal, in-memory implementation of the workerd KV namespace protocol —
 * the HTTP interface a `kvNamespace` binding's backing service must speak
 * (the same protocol Miniflare's KV plugin implements, without persistence):
 *
 * - `GET    /:key`      → value body, `CF-Expiration` / `CF-KV-Metadata` headers, 404 on miss
 * - `PUT    /:key`      → body is the value; `expiration` / `expiration_ttl`
 *                         query params (seconds), `CF-KV-Metadata` header
 * - `DELETE /:key`      → idempotent delete
 * - `GET    /`          → list (`prefix`, `key_count_limit`, `cursor` params)
 * - `POST   /bulk/get`  → `{ keys, type?, withMetadata? }` bulk lookup
 *
 * Each configured namespace gets its own service instance (own isolate), so
 * the module-level store is naturally namespace-scoped. State is ephemeral:
 * it lives for the lifetime of the workerd instance.
 */
/** The request type `ExportedHandler["fetch"]` receives (ambient workers-types globals). */
type WorkerRequest = Request<unknown, IncomingRequestCfProperties<unknown>>;

interface Env {
  [binding: string]: unknown;
}

interface Entry {
  readonly value: Uint8Array;
  /** Epoch milliseconds. */
  readonly expiration?: number;
  /** Raw JSON string from the `CF-KV-Metadata` header. */
  readonly metadata?: string;
}

const HEADER_EXPIRATION = "CF-Expiration";
const HEADER_METADATA = "CF-KV-Metadata";

const PARAM_URL_ENCODED = "urlencoded";
const PARAM_EXPIRATION = "expiration";
const PARAM_EXPIRATION_TTL = "expiration_ttl";
const PARAM_LIST_LIMIT = "key_count_limit";
const PARAM_LIST_PREFIX = "prefix";
const PARAM_LIST_CURSOR = "cursor";

const MAX_LIST_KEYS = 1000;

const store = new Map<string, Entry>();

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  toResponse(): Response {
    return new Response(this.message, { status: this.status });
  }
}

const decodeKey = (url: URL): string => {
  const key = url.pathname.slice(1);
  if (url.searchParams.get(PARAM_URL_ENCODED)?.toLowerCase() !== "true") return key;
  try {
    return decodeURIComponent(key);
  } catch {
    throw new HttpError(400, "Could not URL-decode key name");
  }
};

const validateKey = (key: string): void => {
  if (key === "") throw new HttpError(400, "Key names must not be empty");
  if (key === "." || key === "..") {
    throw new HttpError(400, `Illegal key name "${key}". Please use a different name.`);
  }
  if (new TextEncoder().encode(key).byteLength > 512) {
    throw new HttpError(414, `UTF-8 encoded length of key exceeds key length limit of 512.`);
  }
};

const now = () => Date.now();

const getEntry = (key: string): Entry | undefined => {
  const entry = store.get(key);
  if (entry === undefined) return undefined;
  if (entry.expiration !== undefined && entry.expiration <= now()) {
    store.delete(key);
    return undefined;
  }
  return entry;
};

const handleGet = (url: URL): Response => {
  const key = decodeKey(url);
  validateKey(key);
  const entry = getEntry(key);
  if (entry === undefined) return new Response("Not Found", { status: 404 });
  const headers = new Headers();
  if (entry.expiration !== undefined) {
    headers.set(HEADER_EXPIRATION, Math.floor(entry.expiration / 1000).toString());
  }
  if (entry.metadata !== undefined) {
    headers.set(HEADER_METADATA, entry.metadata);
  }
  return new Response(entry.value, { headers });
};

const handlePut = async (request: WorkerRequest, url: URL): Promise<Response> => {
  const key = decodeKey(url);
  validateKey(key);
  const rawExpiration = url.searchParams.get(PARAM_EXPIRATION);
  const rawExpirationTtl = url.searchParams.get(PARAM_EXPIRATION_TTL);
  let expiration: number | undefined;
  if (rawExpirationTtl !== null) {
    const ttl = parseInt(rawExpirationTtl);
    if (Number.isNaN(ttl) || ttl <= 0) {
      throw new HttpError(
        400,
        `Invalid ${PARAM_EXPIRATION_TTL} of ${rawExpirationTtl}. Please specify integer greater than 0.`,
      );
    }
    expiration = now() + ttl * 1000;
  } else if (rawExpiration !== null) {
    const epochSeconds = parseInt(rawExpiration);
    if (Number.isNaN(epochSeconds) || epochSeconds * 1000 <= now()) {
      throw new HttpError(
        400,
        `Invalid ${PARAM_EXPIRATION} of ${rawExpiration}. Please specify integer greater than the current number of seconds since the UNIX epoch.`,
      );
    }
    expiration = epochSeconds * 1000;
  }
  const metadata = request.headers.get(HEADER_METADATA) ?? undefined;
  const value = new Uint8Array(await request.arrayBuffer());
  store.set(key, { value, expiration, metadata });
  return new Response();
};

const handleDelete = (url: URL): Response => {
  const key = decodeKey(url);
  validateKey(key);
  store.delete(key);
  return new Response();
};

const handleList = (url: URL): Response => {
  const prefix = url.searchParams.get(PARAM_LIST_PREFIX) ?? "";
  const rawLimit = url.searchParams.get(PARAM_LIST_LIMIT);
  const limit = rawLimit === null ? MAX_LIST_KEYS : parseInt(rawLimit);
  if (Number.isNaN(limit) || limit < 1) {
    throw new HttpError(400, `Invalid ${PARAM_LIST_LIMIT} of ${rawLimit}.`);
  }
  const rawCursor = url.searchParams.get(PARAM_LIST_CURSOR);
  const cursorKey = rawCursor !== null ? atob(rawCursor) : undefined;
  const keys = Array.from(store.keys())
    .filter((key) => key.startsWith(prefix) && getEntry(key) !== undefined)
    .sort();
  const startIndex = cursorKey !== undefined ? keys.findIndex((key) => key > cursorKey) : 0;
  const page = startIndex < 0 ? [] : keys.slice(startIndex, startIndex + limit);
  const complete = startIndex < 0 || startIndex + limit >= keys.length;
  return Response.json({
    keys: page.map((key) => {
      const entry = getEntry(key);
      return {
        name: key,
        ...(entry?.expiration !== undefined
          ? { expiration: Math.floor(entry.expiration / 1000) }
          : {}),
        // workerd expects metadata as a JSON-serialised string.
        ...(entry?.metadata !== undefined ? { metadata: entry.metadata } : {}),
      };
    }),
    list_complete: complete,
    ...(complete ? {} : { cursor: btoa(page[page.length - 1]) }),
    cacheStatus: null,
  });
};

const handleBulkGet = async (request: WorkerRequest): Promise<Response> => {
  const body = (await request.json()) as {
    keys?: Array<string>;
    type?: string;
    withMetadata?: boolean;
  };
  const keys = body.keys ?? [];
  const type = body.type ?? "text";
  if (type !== "text" && type !== "json") {
    return new Response(`"${type}" is not a valid type. Use "json" or "text"`, { status: 400 });
  }
  const decoder = new TextDecoder();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    validateKey(key);
    const entry = getEntry(key);
    let value: unknown = null;
    if (entry !== undefined) {
      const text = decoder.decode(entry.value);
      try {
        value = type === "json" ? JSON.parse(text) : text;
      } catch {
        return new Response(
          `At least one of the requested keys corresponds to a non-${type} value`,
          { status: 400 },
        );
      }
      if (body.withMetadata) {
        value = {
          value,
          metadata: entry.metadata !== undefined ? JSON.parse(entry.metadata) : null,
        };
      }
    }
    result[key] = value;
  }
  return Response.json(result);
};

export default {
  async fetch(request: WorkerRequest) {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/bulk/get") {
        return await handleBulkGet(request);
      }
      if (url.pathname === "/" && request.method === "GET") {
        return handleList(url);
      }
      switch (request.method) {
        case "GET":
          return handleGet(url);
        case "PUT":
          return await handlePut(request, url);
        case "DELETE":
          return handleDelete(url);
        default:
          return new Response("Method Not Allowed", { status: 405 });
      }
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse();
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
