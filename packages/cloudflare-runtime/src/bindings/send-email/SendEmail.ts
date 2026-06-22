import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EmailWorker from "worker:./email.worker.ts";
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";

export class SendEmail extends Plugin.Service<SendEmail>()("cloudflare-runtime/plugin/SendEmail") {}

export const SendEmailLive = Layer.succeed(
  SendEmail,
  SendEmail.of(
    Effect.map(formatExtensionModule(EmailWorker), (esModule) => ({
      extensions: [
        {
          modules: [
            {
              name: "cloudflare-internal:email",
              internal: true,
              esModule,
            },
          ],
        },
      ],
    })),
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
