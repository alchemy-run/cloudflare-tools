/**
 * Protocol-level client for `cloudflare-runtime`'s platform proxy, used by
 * the dev-only nitro plugin (`./plugin.ts`) INSIDE nitro's dev SSR worker
 * thread.
 *
 * This is a reimplementation of the Node-side stub client that lives
 * (module-private) in `cloudflare-runtime`'s `platform-proxy/PlatformProxy.ts`,
 * built exclusively on the PUBLIC protocol subpath
 * (`platform-proxy/PlatformProxyProtocol`: path/header constants + the
 * `EncodedValue` codec). It exists because `cloudflare-runtime` does not yet
 * export a runtime-free `connect({ url, token })` client entry point — once
 * that export lands (reported as a cross-package need), this file should be
 * deleted in favor of it.
 *
 * Covered: value bindings, lazy method-chain stubs (`env.KV.get("key")`,
 * `env.DO.get(await env.DO.idFromName("a")).rpc()`), Durable Object id
 * materialisation, `R2Object`/`R2ObjectBody` rehydration, raw `fetch`
 * passthrough for fetch-capable stubs (service bindings, DO stubs).
 * Inherited proxy limitations apply (no sync id materialisation, no
 * `connect()`, JSON-compatible results + bytes/streams only).
 */
import type * as Protocol from "@distilled.cloud/cloudflare-runtime/platform-proxy/PlatformProxyProtocol";
import type { DevConnectInfo } from "./shared.ts";

/** The public protocol module's shape (`platform-proxy/PlatformProxyProtocol`). */
export type ProtocolModule = typeof Protocol;

type EncodedValue = Protocol.EncodedValue;
type EncodedChainSegment = Protocol.EncodedChainSegment;
type EnvDescriptor = Protocol.EnvDescriptor;

interface Client {
  readonly url: string;
  readonly token: string;
  readonly protocol: ProtocolModule;
}

interface ChainSegment {
  readonly method: string;
  readonly args: Array<unknown>;
}

interface ChainRef {
  readonly binding: string;
  readonly chain: Array<ChainSegment>;
}

// Same global symbol keys as cloudflare-runtime's client, so materialised
// values interoperate should they ever cross paths.
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

const isMaterializedId = (value: unknown): value is MaterializedDurableObjectId =>
  typeof value === "object" && value !== null && DURABLE_OBJECT_ID in value;

const getChainRef = (value: unknown): ChainRef | undefined =>
  typeof value === "function" || (typeof value === "object" && value !== null)
    ? ((value as Record<PropertyKey, unknown>)[CHAIN] as ChainRef | undefined)
    : undefined;

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

const encodeArg = (client: Client, binding: string, value: unknown): EncodedValue => {
  const ref = getChainRef(value);
  if (ref !== undefined) {
    if (ref.binding !== binding) {
      throw new Error(
        `platform-proxy: cannot pass a stub of binding "${ref.binding}" to a call on binding "${binding}". ` +
          "Cross-binding stub arguments are not supported.",
      );
    }
    return { $: "chain", chain: encodeChain(client, binding, ref.chain) };
  }
  return client.protocol.encodeValue(value, encodeNodeValue);
};

const encodeChain = (
  client: Client,
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
): Array<EncodedChainSegment> =>
  chain.map((segment) => ({
    method: segment.method,
    args: segment.args.map((arg) => encodeArg(client, binding, arg)),
  }));

const decodeNodeValue =
  (client: Client) =>
  (encoded: EncodedValue): { readonly value: unknown } | undefined => {
    if (encoded.$ === "durable-object-id") {
      return { value: makeDurableObjectId(encoded.id, encoded.name) };
    }
    if (encoded.$ === "r2-object") {
      return { value: decodeR2Object(client, encoded) };
    }
    return undefined;
  };

const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy as Uint8Array<ArrayBuffer>;
};

/**
 * Rehydrate an `R2Object` / `R2ObjectBody` (mirror of the cloudflare-runtime
 * client): plain fields plus, when the worker captured a `get` result's
 * content, a body stream and its buffering accessors.
 */
const decodeR2Object = (
  client: Client,
  encoded: Extract<EncodedValue, { $: "r2-object" }>,
): unknown => {
  const fields = client.protocol.decodeValue(
    { $: "object", value: encoded.fields },
    decodeNodeValue(client),
  ) as Record<string, unknown>;
  const httpMetadata = (fields.httpMetadata ?? {}) as Record<string, unknown>;
  const object: Record<string, unknown> = {
    checksums: {},
    ...fields,
    writeHttpMetadata: (headers: Headers) => {
      const set = (name: string, value: unknown) => {
        if (typeof value === "string") headers.set(name, value);
      };
      set("content-type", httpMetadata.contentType);
      set("content-language", httpMetadata.contentLanguage);
      set("content-disposition", httpMetadata.contentDisposition);
      set("content-encoding", httpMetadata.contentEncoding);
      set("cache-control", httpMetadata.cacheControl);
      if (httpMetadata.cacheExpiry instanceof Date) {
        headers.set("expires", httpMetadata.cacheExpiry.toUTCString());
      }
    },
  };
  if (encoded.body !== undefined) {
    const bytes = client.protocol.base64ToBytes(encoded.body.base64);
    let bodyUsed = false;
    const consume = <T>(f: () => T): T => {
      bodyUsed = true;
      return f();
    };
    Object.defineProperties(object, {
      bodyUsed: { get: () => bodyUsed, enumerable: true },
      body: {
        get: () => consume(() => new Response(copyBytes(bytes)).body),
        enumerable: true,
      },
    });
    object.arrayBuffer = () => Promise.resolve(consume(() => copyBytes(bytes).buffer));
    object.bytes = () => Promise.resolve(consume(() => copyBytes(bytes)));
    object.text = () => Promise.resolve(consume(() => new TextDecoder().decode(bytes)));
    object.json = () => Promise.resolve(consume(() => JSON.parse(new TextDecoder().decode(bytes))));
    object.blob = () => Promise.resolve(consume(() => new Blob([copyBytes(bytes)])));
  }
  return object;
};

const decodeCallError = async (client: Client, response: Response): Promise<Error> => {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: EncodedValue }
    | undefined;
  if (body?.error !== undefined) {
    const decoded = client.protocol.decodeValue(body.error, decodeNodeValue(client));
    if (decoded instanceof Error) return decoded;
    return new Error(String(decoded));
  }
  return new Error(`platform-proxy: request failed with status ${response.status}`);
};

const callBinding = async (
  client: Client,
  binding: string,
  chain: ReadonlyArray<ChainSegment>,
): Promise<unknown> => {
  const response = await fetch(new URL(client.protocol.PATH_CALL, client.url), {
    method: "POST",
    headers: {
      [client.protocol.HEADER_TOKEN]: client.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ binding, chain: encodeChain(client, binding, chain) }),
  });
  const kind = response.headers.get(client.protocol.HEADER_RESULT);
  switch (kind) {
    case "json": {
      const { value } = (await response.json()) as { value: EncodedValue };
      return client.protocol.decodeValue(value, decodeNodeValue(client));
    }
    case "bytes": {
      const buffer = await response.arrayBuffer();
      return response.headers.get(client.protocol.HEADER_BYTES_KIND) === "arraybuffer"
        ? buffer
        : new Uint8Array(buffer);
    }
    case "stream":
      return response.body;
    case "error":
      throw await decodeCallError(client, response);
    default:
      throw new Error(
        `platform-proxy: unexpected response (${response.status}) from the proxy worker`,
      );
  }
};

const passthroughFetch = async (
  client: Client,
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
  headers.set(client.protocol.HEADER_TOKEN, client.token);
  headers.set(client.protocol.HEADER_BINDING, binding);
  headers.set(client.protocol.HEADER_URL, request.url);
  if (chain.length > 0) {
    headers.set(
      client.protocol.HEADER_CHAIN,
      encodeURIComponent(JSON.stringify(encodeChain(client, binding, chain))),
    );
  }
  return await fetch(new URL(client.protocol.PATH_FETCH, client.url), {
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
const makeStub = (client: Client, binding: string, chain: Array<ChainSegment>): unknown => {
  let memo: Promise<unknown> | undefined;
  const run = () => (memo ??= callBinding(client, binding, chain));
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

/**
 * Fetch the proxy's env descriptor and build the `env` object: plain values
 * are materialised, everything else becomes a lazy stub. Literal
 * `info.env` overrides are laid on top (a same-named literal wins).
 */
export const connectPlatformEnv = async (
  info: DevConnectInfo,
  protocol: ProtocolModule,
): Promise<Record<string, unknown>> => {
  const client: Client = { url: info.url, token: info.token, protocol };
  const response = await fetch(new URL(protocol.PATH_ENV, info.url), {
    headers: { [protocol.HEADER_TOKEN]: info.token },
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => {});
    throw new Error(
      `platform-proxy dev bridge: the /env request failed with status ${response.status}. ` +
        "The dev platform proxy may have been restarted — reload the dev server.",
    );
  }
  const descriptor = (await response.json()) as EnvDescriptor;
  const env: Record<string, unknown> = {};
  for (const binding of descriptor.bindings) {
    env[binding.name] =
      binding.kind === "value"
        ? protocol.decodeValue(binding.value, decodeNodeValue(client))
        : makeStub(client, binding.name, []);
  }
  for (const [name, value] of Object.entries(info.env ?? {})) {
    env[name] = value;
  }
  return env;
};

const deepFreeze = (value: Record<string, unknown>): void => {
  Object.freeze(value);
  for (const property of Object.values(value)) {
    if (property !== null && typeof property === "object" && !Object.isFrozen(property)) {
      deepFreeze(property as Record<string, unknown>);
    }
  }
};

/**
 * Static mock of `request.cf` — the same fallback object miniflare (and the
 * host-side platform proxy) uses when it cannot fetch real values.
 */
export const makeCfMock = (): Record<string, unknown> => {
  const cf: Record<string, unknown> = {
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

/**
 * Mock of the Workers `ExecutionContext` (wrangler-parity: methods are
 * no-ops; `waitUntil` accepts the promise and drops it — the dev server is
 * a long-lived Node process, so background work simply runs).
 */
export const makeExecutionContextMock = (): {
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
  props: Record<string, unknown>;
} => ({
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
  props: {},
});
