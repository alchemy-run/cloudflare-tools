/** Workerd socket name for the user HTTP entrypoint. */
export const SOCKET_HTTP = "http";

/** Workerd service name of the per-worker dev-registry proxy worker. */
export const SERVICE_DEV_REGISTRY_PROXY = "__distilled:dev-registry-proxy";

/** Workerd socket name used to push registry updates to the proxy worker. */
export const SOCKET_DEV_REGISTRY = "__distilled:dev-registry";

/** Workerd socket name for the cap'n proto debug port. */
export const SOCKET_DEBUG_PORT = "debug-port";

/** Name of the workerdDebugPort binding inside the proxy worker. */
export const DEV_REGISTRY_DEBUG_PORT_BINDING = "DEV_REGISTRY_DEBUG_PORT";

/**
 * Stable workerd service name used as `defaultEntrypointService` /
 * `userWorkerService` for cloudflare-runtime workers. Matches the user
 * service name emitted by {@link Runtime.start}.
 */
export const USER_WORKER_SERVICE_NAME = "user";

/**
 * Class name used for an external Durable Object proxy class on the
 * dev-registry-proxy service. Must match between sides (caller's binding
 * and the proxy worker's namespace declaration).
 */
export const getOutboundDoProxyClassName = (scriptName: string, className: string): string =>
  `${scriptName}_${className}`;
