// NOTE: a top-level `import { env } from "cloudflare:workers"` here breaks the
// SSG step of `buildApp` (waku imports every page module in Node to read
// `getConfig`, and Node cannot load the `cloudflare:` scheme). Upstream has the
// identical limitation when @cloudflare/vite-plugin's preview isn't serving the
// SSG loopback (adapter "fallback middleware" path). So we use the same guarded
// dynamic-import trick waku's adapter uses.
const DO_NOT_BUNDLE = "";

async function readEnv(): Promise<Record<string, unknown>> {
  try {
    const mod = await import(/* @vite-ignore */ DO_NOT_BUNDLE + "cloudflare:workers");
    return mod.env as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default async function HomePage() {
  const env = await readEnv();
  return (
    <div>
      <div data-testid="page-marker">PAGE_MARKER</div>
      <div data-testid="cloudflare-env">MAX_ITEMS={String(env.MAX_ITEMS ?? "unset")}</div>
    </div>
  );
}

// Dynamic so the worker must serve it at request time (exercises the
// cloudflare:workers env binding in both dev/workerd and preview/miniflare).
export const getConfig = async () => ({ render: "dynamic" }) as const;
