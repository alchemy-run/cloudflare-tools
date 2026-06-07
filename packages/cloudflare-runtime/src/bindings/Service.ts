import * as Effect from "effect/Effect";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";
import { RegistryProxy } from "../registry/RegistryProxy.ts";
import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export interface LocalServiceProps {
  /**
   * Name of the binding.
   */
  readonly binding: string;
  /**
   * Name of the worker (as registered in the dev registry by another
   * `cloudflare-runtime` or `wrangler dev` process) to bind to.
   */
  readonly scriptName: string;
  /**
   * Named entrypoint on the target worker. Defaults to the default entrypoint.
   */
  readonly entrypoint?: string;
  /**
   * Optional `ctx.props` forwarded to the remote entrypoint.
   */
  readonly props?: Record<string, unknown>;
}

/**
 * Bind to another locally-running worker by name. The connection is
 * established cross-process via the workerd debug port and the on-disk
 * dev registry, so the target worker can be running in a separate
 * `cloudflare-runtime` or `wrangler dev` process.
 */
export const local = ({
  binding,
  scriptName,
  entrypoint,
  props,
}: LocalServiceProps): BindingHook<RegistryProxy> =>
  Plugin.use(RegistryProxy, (proxy) =>
    proxy.api
      .subscribe({
        kind: "worker",
        scriptName,
        entrypoint,
        props,
      })
      .pipe(
        Effect.map((service) => ({
          name: binding,
          service,
        })),
      ),
  );

/**
 * Bind to a deployed Cloudflare Worker via the remote bindings proxy.
 */
export const remote = (name: string, service: string) =>
  makeRemoteBinding({ name, type: "service", service }, (service) => ({
    name,
    service,
  }));
