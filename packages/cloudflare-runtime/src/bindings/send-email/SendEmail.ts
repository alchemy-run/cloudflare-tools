import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EmailWorker from "worker:./email.worker.ts";
import * as LocalEmailWorker from "worker:./send-email.worker.ts";
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";

export class SendEmail extends Plugin.Service<SendEmail>()("cloudflare-runtime/plugin/SendEmail") {}

/**
 * Wrapped-binding module for the local `send()` stub — see
 * `send-email.worker.ts`. Registered alongside the `cloudflare-internal:email`
 * shim so {@link local} can point its wrapped binding at it.
 */
const LOCAL_SEND_EMAIL_MODULE = "cloudflare-runtime:send-email";

export const SendEmailLive = Layer.succeed(
  SendEmail,
  SendEmail.of(
    Effect.map(
      Effect.all([formatExtensionModule(EmailWorker), formatExtensionModule(LocalEmailWorker)]),
      ([emailShim, localStub]) => ({
        extensions: [
          {
            modules: [
              {
                name: "cloudflare-internal:email",
                internal: true,
                esModule: emailShim,
              },
              {
                name: LOCAL_SEND_EMAIL_MODULE,
                internal: true,
                esModule: localStub,
              },
            ],
          },
        ],
      }),
    ),
  ),
);

export interface RemoteSendEmailProps {
  readonly binding: string;
  readonly destinationAddress?: string;
  readonly allowedDestinationAddresses?: Array<string>;
  readonly allowedSenderAddresses?: Array<string>;
}

/**
 * Bind to a deployed `send_email` binding via the remote bindings proxy.
 *
 * Also registers the `cloudflare-internal:email` extension that exposes
 * the `EmailMessage` class to user code (workerd does not ship it
 * natively), matching the upstream Miniflare behavior.
 */
export const remote = (props: RemoteSendEmailProps): BindingHook<RemoteBindings | SendEmail> =>
  Plugin.use(SendEmail, () =>
    makeRemoteBinding(
      {
        name: props.binding,
        type: "send_email",
        destinationAddress: props.destinationAddress,
        allowedDestinationAddresses: props.allowedDestinationAddresses,
        allowedSenderAddresses: props.allowedSenderAddresses,
      },
      (service) => ({
        name: props.binding,
        service,
      }),
    ),
  );

export interface LocalSendEmailProps {
  readonly binding: string;
  readonly destinationAddress?: string;
  readonly allowedDestinationAddresses?: Array<string>;
  readonly allowedSenderAddresses?: Array<string>;
}

/**
 * Bind a local `send_email` stub for `alchemy dev`. `send()` logs the message
 * and resolves instead of delivering real mail — matching how Miniflare and
 * Wrangler treat `send_email` unless you opt into the real, remote binding.
 *
 * Reuses the `cloudflare-internal:email` `EmailMessage` shim registered by
 * {@link SendEmailLive} (same as {@link remote}), so user code can still
 * construct `EmailMessage` instances in dev. The address props are accepted
 * to mirror {@link remote}'s signature; the stub does not enforce them.
 */
export const local = (props: LocalSendEmailProps): BindingHook<SendEmail> =>
  Plugin.useSync(SendEmail, () => ({
    name: props.binding,
    wrapped: {
      moduleName: LOCAL_SEND_EMAIL_MODULE,
      innerBindings: [],
    },
  }));
