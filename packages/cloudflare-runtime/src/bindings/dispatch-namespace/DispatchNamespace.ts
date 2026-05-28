import * as Layer from "effect/Layer";
import * as DispatchNamespaceBindingWorker from "worker:./dispatch-namespace.worker.ts";
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";

export class DispatchNamespace extends Plugin.Service<DispatchNamespace>()(
  "cloudflare-runtime/plugin/DispatchNamespace",
) {}

const EXTENSION_MODULE_NAME = "cloudflare-runtime:dispatch-namespace";

export const DispatchNamespaceLive = Layer.succeed(
  DispatchNamespace,
  DispatchNamespace.of({
    extensions: [
      {
        modules: [
          {
            name: EXTENSION_MODULE_NAME,
            internal: true,
            esModule: formatExtensionModule(DispatchNamespaceBindingWorker),
          },
        ],
      },
    ],
  }),
);

/**
 * Bind to a deployed dispatch namespace via the remote bindings proxy.
 *
 * Wraps the remote-bindings client service so user code can call
 * `env.BINDING.get(name, args, options).fetch(...)` against a user worker
 * dispatched from the remote namespace.
 */
export const remote = (
  binding: string,
  namespace: string,
): BindingHook<RemoteBindings | DispatchNamespace> =>
  Plugin.use(DispatchNamespace, () =>
    makeRemoteBinding(
      {
        name: binding,
        type: "dispatch_namespace",
        namespace,
      },
      (service) => ({
        name: binding,
        wrapped: {
          moduleName: EXTENSION_MODULE_NAME,
          innerBindings: [{ name: "proxyClient", service }],
        },
      }),
    ),
  );
