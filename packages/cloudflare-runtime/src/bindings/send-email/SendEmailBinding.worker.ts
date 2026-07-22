/**
 * Local `send_email` binding stub. Workerd has no real outbound email, and
 * under `alchemy dev` we deliberately do not proxy to the deployed binding
 * unless asked — so `send()` logs the message metadata and resolves instead
 * of delivering. This matches how Miniflare/Wrangler treat `send_email`
 * unless you opt into the real, remote binding. Mirrors the no-op
 * `analytics-engine.worker.ts` stub, but logs rather than discards so the
 * dev loop still shows what would have been sent.
 */

interface LoggableMessage {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
}

const formatAddress = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatAddress).join(", ");
  if (value && typeof value === "object") {
    const email = (value as { email?: unknown }).email;
    if (typeof email === "string") return email;
    return JSON.stringify(value);
  }
  return "<unset>";
};

class LocalSendEmail {
  // Accepts both the builder-form message and a pre-built `EmailMessage`
  // (which carries `from`/`to` but keeps the subject inside its raw MIME).
  async send(message: LoggableMessage): Promise<void> {
    const parts = [`from=${formatAddress(message?.from)}`, `to=${formatAddress(message?.to)}`];
    if (typeof message?.subject === "string") {
      parts.push(`subject=${JSON.stringify(message.subject)}`);
    }
    // Logging IS the behavior of this stub — surface the send in the dev loop.
    console.log(
      `[alchemy dev] send_email not delivered (${parts.join(" ")}); ` +
        `body suppressed locally — opt into the real binding with ` +
        `\`dev: { remote: true }\` to send for real`,
    );
  }
}

export default function makeBinding(_env: unknown): LocalSendEmail {
  return new LocalSendEmail();
}
