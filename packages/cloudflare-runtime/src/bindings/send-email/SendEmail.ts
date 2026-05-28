import * as Layer from "effect/Layer";
import * as EmailWorker from "worker:./email.worker.ts";
import { formatExtensionModule } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import type { RemoteBindings } from "../../remote-bindings/RemoteBindings.ts";

export class SendEmail extends Plugin.Service<SendEmail>()("cloudflare-runtime/plugin/SendEmail") {}

export const SendEmailLive = Layer.succeed(
  SendEmail,
  SendEmail.of({
    extensions: [
      {
        modules: [
          {
            name: "cloudflare-internal:email",
            internal: true,
            esModule: formatExtensionModule(EmailWorker),
          },
        ],
      },
    ],
  }),
);

export interface RemoteSendEmailProps {
  readonly destinationAddress?: string;
  readonly allowedDestinationAddresses?: ReadonlyArray<string>;
  readonly allowedSenderAddresses?: ReadonlyArray<string>;
}

/**
 * Bind to a deployed `send_email` binding via the remote bindings proxy.
 *
 * Also registers the `cloudflare-internal:email` extension that exposes
 * the `EmailMessage` class to user code (workerd does not ship it
 * natively), matching the upstream Miniflare behaviour.
 */
export const remote = (
  binding: string,
  props: RemoteSendEmailProps = {},
): BindingHook<RemoteBindings | SendEmail> =>
  Plugin.use(SendEmail, () =>
    makeRemoteBinding(
      {
        name: binding,
        type: "send_email",
        ...(props.destinationAddress !== undefined
          ? { destinationAddress: props.destinationAddress }
          : {}),
        ...(props.allowedDestinationAddresses !== undefined
          ? { allowedDestinationAddresses: [...props.allowedDestinationAddresses] }
          : {}),
        ...(props.allowedSenderAddresses !== undefined
          ? { allowedSenderAddresses: [...props.allowedSenderAddresses] }
          : {}),
      },
      (service) => ({
        name: binding,
        service,
      }),
    ),
  );
