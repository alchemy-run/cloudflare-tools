/**
 * Workerd does not natively expose the `EmailMessage` class that the
 * Cloudflare Workers runtime provides. This extension module ships a
 * minimal shim under `cloudflare-internal:email`, matching the upstream
 * Miniflare implementation, so user code can construct `EmailMessage`
 * instances and pass them to `env.SEND_EMAIL.send(...)`.
 */

const RAW_EMAIL = "EmailMessage::raw";

class EmailMessage {
  constructor(
    public readonly from: string,
    public readonly to: string,
    raw: ReadableStream | string,
  ) {
    // EmailMessage must:
    // - be constructable (matches production),
    // - survive JSRPC (so `message.reply(EmailMessage)` works),
    // - expose `from`/`to` synchronously (rules out an `RpcStub`).
    // Returning a plain object from the constructor is the only way we
    // found to satisfy all three. Mirrors Miniflare's implementation.
    return {
      from,
      to,
      [RAW_EMAIL]: raw,
    } as unknown as EmailMessage;
  }
}

export default {
  EmailMessage,
};
