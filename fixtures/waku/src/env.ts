// NOTE: a top-level `import { env } from "cloudflare:workers"` breaks the SSG
// step of `buildApp` (waku imports every page module in Node to read
// `getConfig`, and Node cannot load the `cloudflare:` scheme). Upstream has
// the identical limitation when @cloudflare/vite-plugin's preview isn't
// serving the SSG loopback (adapter "fallback middleware" path). So we use
// the same guarded dynamic-import trick waku's adapter uses.
const DO_NOT_BUNDLE = "";

export async function readEnv(): Promise<Record<string, unknown>> {
  try {
    const mod = await import(/* @vite-ignore */ DO_NOT_BUNDLE + "cloudflare:workers");
    return mod.env as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function readMessage(): Promise<string> {
  const env = await readEnv();
  return String(env.MESSAGE ?? "unset");
}
