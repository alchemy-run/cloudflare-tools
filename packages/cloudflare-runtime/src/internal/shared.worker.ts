/**
 * Utilities shared between the internal workers that simulate bindings
 * locally (KV, R2, Queues, ...), adapted from Miniflare's
 * `workers-sdk/packages/miniflare/src/workers/shared/*`.
 *
 * Not a worker itself: the `.worker.ts` suffix ensures this module is
 * type-checked against `@cloudflare/workers-types` (it is excluded from the
 * worker entry points in `tsdown.config.ts`, and bundled into the workers
 * that import it).
 */

export function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) throw new Error(message ?? "Assertion failed");
}

export class HttpError extends Error {
  constructor(
    readonly code: number,
    message?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = `${new.target.name} [${code}]`;
  }

  toResponse(): Response {
    return new Response(this.message, {
      status: this.code,
      // Custom statusMessage is required for runtime error messages
      statusText: this.message.substring(0, 512),
    });
  }
}

export type Awaitable<T> = T | Promise<T>;

export function maybeApply<From, To>(
  f: (value: From) => To,
  maybeValue: From | undefined,
): To | undefined {
  return maybeValue === undefined ? undefined : f(maybeValue);
}

/**
 * Real/fake clock. Tests enable fake time via control operations to exercise
 * time-dependent behaviour (e.g. expiration) without waiting, and to
 * deterministically await background blob deletions (`waitForFakeTasks`).
 */
export class Timers {
  /** Fake unix time in milliseconds. If defined, fake timers are enabled. */
  #fakeTimestamp?: number;
  #fakeRunningTasks = new Set<Promise<unknown>>();

  now = () => this.#fakeTimestamp ?? Date.now();

  queueMicrotask(closure: () => Awaitable<unknown>): void {
    if (this.#fakeTimestamp === undefined) return queueMicrotask(() => void closure());
    const result = closure();
    if (result instanceof Promise) {
      this.#fakeRunningTasks.add(result);
      result.finally(() => this.#fakeRunningTasks.delete(result));
    }
  }

  enableFakeTimers(timestamp: number) {
    this.#fakeTimestamp = timestamp;
  }
  disableFakeTimers() {
    this.#fakeTimestamp = undefined;
  }
  advanceFakeTime(delta: number) {
    assert(
      this.#fakeTimestamp !== undefined,
      "Expected fake timers to be enabled before `advanceFakeTime()` call",
    );
    this.#fakeTimestamp += delta;
  }
  async waitForFakeTasks() {
    while (this.#fakeRunningTasks.size > 0) {
      await Promise.all(this.#fakeRunningTasks);
    }
  }
}

export function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(encoded: string): string {
  return new TextDecoder().decode(base64DecodeBytes(encoded));
}

export function base64DecodeBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/*! Path sanitisation regexps adapted from node-sanitize-filename:
 * https://github.com/parshap/node-sanitize-filename/blob/209c39b914c8eb48ee27bcbde64b2c7822fdf3de/index.js#L4-L37
 * Licensed under the ISC license (Copyright Parsha Pourkhomami).
 */
const dotRegexp = /(^|\/|\\)(\.+)(\/|\\|$)/g;
// oxlint-disable-next-line no-control-regex
const illegalRegexp = /[?<>*"'^/\\:|\x00-\x1f\x80-\x9f]/g;
const windowsReservedRegexp = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const leadingRegexp = /^[ /\\]+/;
const trailingRegexp = /[ /\\]+$/;

function dotReplacement(_match: string, g1: string, g2: string, g3: string) {
  return `${g1}${"".padStart(g2.length, "_")}${g3}`;
}
function underscoreReplacement(match: string) {
  return "".padStart(match.length, "_");
}
function sanitisePath(unsafe: string): string {
  return unsafe
    .replace(dotRegexp, dotReplacement)
    .replace(dotRegexp, dotReplacement)
    .replace(illegalRegexp, "_")
    .replace(windowsReservedRegexp, "_")
    .replace(leadingRegexp, underscoreReplacement)
    .replace(trailingRegexp, underscoreReplacement)
    .substring(0, 255);
}

export interface InclusiveRange {
  start: number; // inclusive
  end: number; // inclusive
}

/** Serialisable, opaque, unguessable blob identifier. */
export type BlobId = string;

function generateBlobId(): BlobId {
  const bytes = new Uint8Array(40);
  crypto.getRandomValues(bytes.subarray(0, 32));
  const timestamp = BigInt(Math.floor(performance.timeOrigin + performance.now()));
  new DataView(bytes.buffer).setBigInt64(32, timestamp);
  return hexEncode(bytes);
}

/**
 * Store for binary large objects, backed by a disk service. Blobs have
 * unguessable identifiers, can be deleted, but are otherwise immutable, which
 * makes atomic updates with a SQLite metadata store possible: a blob is
 * unreachable until its id is committed to the metadata store, and dangling
 * blobs (e.g. after a failed insert) are simply garbage-collected. Reads may
 * be ranged, so e.g. R2 multipart gets only stream the parts covering the
 * requested range.
 */
export class BlobStore {
  readonly #fetcher: Fetcher;
  readonly #baseURL: string;

  constructor(fetcher: Fetcher, namespace: string) {
    // `baseURL`'s pathname is relative to the disk service's root, so blobs
    // for namespace `ns` live in `{persistPath}/ns/blobs/`.
    this.#fetcher = fetcher;
    this.#baseURL = `http://placeholder/${encodeURIComponent(sanitisePath(namespace))}/blobs/`;
  }

  #idURL(id: BlobId): URL | null {
    const url = new URL(this.#baseURL + id);
    return url.toString().startsWith(this.#baseURL) ? url : null;
  }

  async get(id: BlobId, range?: InclusiveRange): Promise<ReadableStream<Uint8Array> | null> {
    const idURL = this.#idURL(id);
    if (idURL === null) return null;
    const headers: HeadersInit =
      range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` };
    const res = await this.#fetcher.fetch(idURL, { headers });
    if (res.status === 404) return null;
    assert(res.ok && res.body !== null);
    if (range !== undefined && res.status !== 206) {
      // If we specified a range, but received full content, make sure the
      // range covered the full content
      const contentLength = parseInt(res.headers.get("Content-Length") ?? "NaN");
      assert(!Number.isNaN(contentLength));
      assert(
        range.start === 0 && range.end === contentLength - 1,
        "Received full content, but requested partial content",
      );
    }
    return res.body;
  }

  async put(stream: ReadableStream<Uint8Array>): Promise<BlobId> {
    const id = generateBlobId();
    // Blob IDs are hex, so this should never be `null`
    const idURL = this.#idURL(id);
    assert(idURL !== null);
    await this.#fetcher.fetch(idURL, { method: "PUT", body: stream });
    return id;
  }

  async delete(id: BlobId): Promise<void> {
    // Ignore if outside root or not found
    const idURL = this.#idURL(id);
    if (idURL === null) return;
    const res = await this.#fetcher.fetch(idURL, { method: "DELETE" });
    assert(res.ok || res.status === 404);
  }
}
