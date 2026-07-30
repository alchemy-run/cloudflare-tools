/**
 * Cloudflare dev transport — HOST half.
 *
 * Runs in the alchemy / e2e-harness process: opens `cloudflare-runtime`'s
 * platform proxy (a local workerd instance hosting the configured binding
 * hooks behind the internal proxy worker) and produces the
 * {@link NuxtDevPlatform} the framework half injects into `loadNuxt`
 * overrides — the dev-only nitro plugin (`./plugin.ts`) plus the
 * `runtimeConfig` connect info (`{ url, token }` — the proxy's entire
 * client state is two plain strings, which is what lets the nitro dev SSR
 * worker THREAD reconstruct `env` over HTTP with live-shared binding
 * state).
 *
 * Token workaround: `cloudflare-runtime` generates the proxy auth token
 * inside `open()` (`crypto.randomUUID()`) and does not expose it on
 * `PlatformProxyInstance` — a `connectInfo`/`connect()` export has been
 * reported as a cross-package need. Until it lands, the token is recovered
 * by capturing the UUIDs generated while `getPlatformProxy` runs and
 * probing the proxy's `/env` endpoint with each candidate (wrong tokens
 * 401; the real one authenticates). The capture window is serialized
 * process-wide and always restores the original `crypto.randomUUID`.
 */
import { DeployTargetError } from "@distilled.cloud/framework-core";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import type { NuxtDevPlatform, NuxtDevPlatformContext } from "../Nuxt.ts";
import { RUNTIME_CONFIG_KEY, type DevConnectInfo } from "./shared.ts";

const requireHere = createRequire(import.meta.url);

/**
 * The public protocol subpath of `cloudflare-runtime` the dev plugin's
 * client is built on. Resolved HOST-side (this package depends on
 * `cloudflare-runtime`) to an absolute path the dev worker imports
 * directly — the worker itself cannot resolve the bare specifier when
 * `cloudflare-runtime` is only a transitive dependency of the project.
 */
export const PROTOCOL_MODULE_SPECIFIER =
  "@distilled.cloud/cloudflare-runtime/platform-proxy/PlatformProxyProtocol";

/** Resolve the absolute path of the shipped dev-only nitro plugin. */
export const resolveDevPluginPath = (): string => {
  const here = fileURLToPath(import.meta.url);
  // src (bun/vitest run the .ts sources; nitro transpiles TS plugins) vs
  // dist (node runs the compiled .js).
  const extension = here.endsWith(".ts") ? ".ts" : ".js";
  return NodePath.join(NodePath.dirname(here), `plugin${extension}`);
};

/** Resolve {@link PROTOCOL_MODULE_SPECIFIER} to an absolute file path. */
export const resolveProtocolModulePath = (): string =>
  requireHere.resolve(PROTOCOL_MODULE_SPECIFIER);

/** What the dev platform needs back from an opened proxy. */
export interface DevProxyHandle {
  /** Base URL of the proxy workerd instance. */
  readonly url: string;
  /** The recovered auth token. */
  readonly token: string;
  /** Tear the proxy down. Safe to call multiple times. */
  readonly dispose: () => Promise<void>;
}

export interface OpenDevProxyOptions {
  readonly name: string;
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  /** `cloudflare-runtime` binding hooks (opaque through the framework half). */
  readonly bindings: ReadonlyArray<unknown>;
}

/** How the platform proxy is opened. A test seam; the default is {@link openPlatformProxy}. */
export type OpenDevProxy = (options: OpenDevProxyOptions) => Promise<DevProxyHandle>;

// Serializes UUID-capture windows process-wide so concurrent opens never
// interleave the patch/restore of the global `crypto.randomUUID`.
let captureQueue: Promise<void> = Promise.resolve();

/**
 * Run `open` while recording every UUID `crypto.randomUUID()` hands out.
 * Unrelated concurrent callers still receive real UUIDs (the capture only
 * observes); the original function is always restored.
 */
export const withUuidCapture = async <T>(
  open: () => Promise<T>,
): Promise<{ value: T; candidates: Array<string> }> => {
  const previous = captureQueue;
  let release!: () => void;
  captureQueue = new Promise((resolve) => (release = resolve));
  await previous;
  const candidates: Array<string> = [];
  const original = crypto.randomUUID;
  crypto.randomUUID = (() => {
    const uuid = original.call(crypto);
    candidates.push(uuid);
    return uuid;
  }) as typeof crypto.randomUUID;
  try {
    const value = await open();
    return { value, candidates };
  } finally {
    crypto.randomUUID = original;
    release();
  }
};

/**
 * Find the proxy's auth token among the captured UUID candidates by probing
 * the (localhost) `/env` endpoint: wrong tokens 401, the real one
 * authenticates.
 */
export const recoverProxyToken = async (
  url: string | URL,
  candidates: ReadonlyArray<string>,
  protocol: { readonly PATH_ENV: string; readonly HEADER_TOKEN: string },
): Promise<string> => {
  for (const candidate of candidates) {
    const response = await fetch(new URL(protocol.PATH_ENV, url), {
      headers: { [protocol.HEADER_TOKEN]: candidate },
    });
    await response.arrayBuffer().catch(() => {});
    if (response.ok) {
      return candidate;
    }
  }
  throw new Error(
    "Could not recover the platform-proxy auth token: none of the " +
      `${candidates.length} captured UUID candidates authenticated against the proxy's ` +
      "/env endpoint. The installed @distilled.cloud/cloudflare-runtime may have changed " +
      "how the token is generated — this workaround is interim until the runtime exposes " +
      "the token (`connectInfo`) on PlatformProxyInstance.",
  );
};

/**
 * The default opener: `cloudflare-runtime`'s `getPlatformProxy` (imported
 * lazily so production builds never load the runtime machinery) plus the
 * token recovery described in the module doc.
 */
export const openPlatformProxy: OpenDevProxy = async (options) => {
  const [{ getPlatformProxy }, protocol] = await Promise.all([
    import("@distilled.cloud/cloudflare-runtime/platform-proxy"),
    import(PROTOCOL_MODULE_SPECIFIER) as Promise<{
      PATH_ENV: string;
      HEADER_TOKEN: string;
    }>,
  ]);
  const { value: proxy, candidates } = await withUuidCapture(() =>
    getPlatformProxy({
      name: options.name,
      ...(options.compatibilityDate !== undefined
        ? { compatibilityDate: options.compatibilityDate }
        : undefined),
      ...(options.compatibilityFlags !== undefined
        ? { compatibilityFlags: [...options.compatibilityFlags] }
        : undefined),
      bindings: options.bindings as Parameters<typeof getPlatformProxy>[0]["bindings"],
    }),
  );
  try {
    const token = await recoverProxyToken(proxy.url, candidates, protocol);
    return { url: proxy.url.href, token, dispose: proxy.dispose };
  } catch (error) {
    await proxy.dispose().catch(() => {});
    throw error;
  }
};

export interface CloudflareDevPlatformOptions {
  /** Name of the proxy workerd service. @default "nuxt-dev-platform-proxy" */
  readonly name?: string | undefined;
  /** Compatibility date for the binding-proxy workerd instance. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags for the binding-proxy workerd instance. */
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  /** Override how the proxy is opened. A test seam. */
  readonly openProxy?: OpenDevProxy | undefined;
}

/**
 * Literal env values for the plugin: strings pass through; everything else
 * (resource bindings) is delivered through the proxy itself.
 */
const literalEnv = (
  env: Record<string, unknown> | undefined,
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * The Cloudflare target's dev platform: open the proxy (scoped — closing
 * the Scope disposes the workerd instance) and hand the framework half the
 * nitro plugin + `runtimeConfig` connect info to inject.
 */
export const makeCloudflareDevPlatform =
  (options: CloudflareDevPlatformOptions = {}) =>
  (
    context: NuxtDevPlatformContext,
  ): Effect.Effect<NuxtDevPlatform, DeployTargetError, Scope.Scope> =>
    Effect.gen(function* () {
      const open = options.openProxy ?? openPlatformProxy;
      const proxy = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            open({
              name: options.name ?? "nuxt-dev-platform-proxy",
              compatibilityDate: options.compatibilityDate,
              compatibilityFlags: options.compatibilityFlags,
              bindings: context.bindings ?? [],
            }),
          catch: (cause) =>
            new DeployTargetError({
              platform: "cloudflare",
              message: "Failed to open the dev platform proxy",
              cause,
            }),
        }),
        (handle) => Effect.promise(() => handle.dispose().catch(() => {})),
      );
      const protocolModule = yield* Effect.try({
        try: resolveProtocolModulePath,
        catch: (cause) =>
          new DeployTargetError({
            platform: "cloudflare",
            message:
              `Failed to resolve "${PROTOCOL_MODULE_SPECIFIER}" — the Nuxt dev bridge ` +
              "requires @distilled.cloud/cloudflare-runtime (a dependency of this package)",
            cause,
          }),
      });
      const env = literalEnv(context.env);
      const connectInfo: DevConnectInfo = {
        url: proxy.url,
        token: proxy.token,
        protocolModule,
        ...(env !== undefined ? { env } : {}),
      };
      return {
        nitroPlugins: [resolveDevPluginPath()],
        runtimeConfig: { [RUNTIME_CONFIG_KEY]: connectInfo },
      } satisfies NuxtDevPlatform;
    });
