import { defineConfig } from "vite";
import * as vite from "vite";
import { unstable_resolveConfig as resolveConfig } from "waku/internals";
import { unstable_combinedPlugins as combinedPlugins } from "waku/vite-plugins";

// In-memory waku config — no waku.config.ts, no wrangler.jsonc.
// The adapter is imported directly by src/waku.server.tsx (our wrangler-free fork),
// so `unstable_adapter` (which only affects managed mode) is left at its default.
const wakuConfig = resolveConfig({
  // Managed mode: no src/waku.server.tsx — waku generates the server entry
  // (`import adapter from 'waku/adapters/default'`) and adapterAliasPlugin
  // resolves it to our wrangler-free fork via this in-memory module id.
  unstable_adapter: new URL("./src/adapter.cloudflare.ts", import.meta.url).pathname,
  vite: {
    environments: {
      rsc: {
        optimizeDeps: { include: ["hono/tiny"] },
        build: { rolldownOptions: { platform: "neutral" } },
      },
      ssr: {
        optimizeDeps: { include: ["waku > rsc-html-stream/server"] },
        build: { rolldownOptions: { platform: "neutral" } },
      },
    },
  },
});

export default defineConfig(({ command }) => {
  // waku's CLI sets this before loading anything (cmd-dev.ts / cmd-build.ts);
  // we replicate it because waku's environmentsPlugin bakes
  // `process.env.NODE_ENV` into `define`.
  process.env.NODE_ENV ??= command === "build" ? "production" : "development";

  if (command === "build") {
    // Replicates waku's cmd-build.ts `startPreviewServerImpl`: the SSG step of
    // `builder.buildApp()` (adapter `build`) calls `unstable_startPreviewServer`
    // which throws unless this global is set.
    (globalThis as Record<string, unknown>).__WAKU_START_PREVIEW_SERVER__ = async () => {
      const server = await vite.preview({
        configFile: false,
        plugins: [combinedPlugins(wakuConfig)],
      });
      return {
        baseUrl: server.resolvedUrls!.local[0]!,
        middlewares: {
          use: (fn: (req: unknown, res: unknown, next: (err?: unknown) => void) => void) =>
            server.middlewares.use(fn as never),
        },
        close: () => server.close(),
      };
    };
  }

  return {
    plugins: [combinedPlugins(wakuConfig)],
  };
});
