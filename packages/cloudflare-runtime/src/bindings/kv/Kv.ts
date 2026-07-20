/**
 * Local KV namespace emulation: a `kvNamespace` binding backed by an
 * in-memory worker service implementing the workerd KV protocol
 * ({@link ./kv-namespace.worker.ts}).
 *
 * Each distinct namespace id gets its own backing service (own isolate), so
 * two bindings that share a `namespaceId` observe the same data while
 * distinct namespaces are isolated. State is ephemeral — it lives for the
 * lifetime of the workerd instance and is not persisted to disk.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KvNamespaceWorker from "worker:./kv-namespace.worker.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";

const KV_COMPATIBILITY_DATE = "2026-03-10";

export class Kv extends Plugin.Service<
  Kv,
  {
    /**
     * Register a namespace and resolve the workerd service designator its
     * `kvNamespace` binding should target.
     */
    readonly register: (namespaceId: string) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/Kv") {}

export const KvLive = Layer.succeed(
  Kv,
  Kv.of(
    Effect.sync(() => {
      const namespaces = new Set<string>();
      const serviceName = (namespaceId: string) => `kv:${namespaceId}`;
      return {
        api: {
          register: (namespaceId: string) =>
            Effect.sync(() => {
              namespaces.add(namespaceId);
              return { name: serviceName(namespaceId) };
            }),
        },
        defer: Effect.suspend(() =>
          Effect.map(Effect.promise(KvNamespaceWorker.worker), (worker) => ({
            services: Array.from(
              namespaces,
              (namespaceId): WorkerdConfig.Service => ({
                name: serviceName(namespaceId),
                worker: {
                  compatibilityDate: KV_COMPATIBILITY_DATE,
                  modules: formatInternalWorkerModules(worker),
                },
              }),
            ),
          })),
        ),
      };
    }),
  ),
);

export interface LocalKvNamespaceProps {
  /**
   * Namespace id backing the binding. Bindings sharing an id observe the
   * same data; distinct ids are isolated.
   * @default the binding name
   */
  readonly namespaceId?: string;
}

/**
 * Bind an in-memory local KV namespace (`env.<binding>.get/put/delete/list`).
 */
export const local = (binding: string, props: LocalKvNamespaceProps = {}): BindingHook<Kv> =>
  Plugin.use(Kv, (kv) =>
    Effect.map(kv.api.register(props.namespaceId ?? binding), (kvNamespace) => ({
      name: binding,
      kvNamespace,
    })),
  );
