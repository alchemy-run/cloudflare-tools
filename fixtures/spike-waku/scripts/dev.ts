/**
 * Dev spike: waku through our cloudflare-vite-plugin, with the plugin injected
 * via waku's `config.vite.plugins` (extraPlugins) — the SAME position upstream
 * documents for @cloudflare/vite-plugin. This makes our plugin's
 * configureServer post-middleware register BEFORE waku's Node request-bridge
 * middleware (waku:vite-plugins:environments), which otherwise handles the
 * request first and crashes on `DistilledDevEnvironment.runner` (undefined).
 *
 * Appending the plugin AFTER combinedPlugins (what the e2e harness does today)
 * is proven broken for waku — see the spike report.
 */
import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import cloudflareVitePlugin from "@distilled.cloud/cloudflare-vite-plugin";
import { createRequire } from "node:module";
import path from "node:path";
import * as vite from "vite";
import { unstable_resolveConfig as resolveConfig } from "waku/internals";
import { unstable_combinedPlugins as combinedPlugins } from "waku/vite-plugins";

process.env.NODE_ENV ??= "development";

const require = createRequire(import.meta.url);
const wakuDir = path.dirname(require.resolve("waku/package.json"));
const root = path.resolve(import.meta.dirname, "..");

const wakuConfig = resolveConfig({
  // Managed mode: waku's generated server entry imports 'waku/adapters/default';
  // this in-memory module id makes adapterAliasPlugin resolve it to our
  // wrangler-free fork. Without it, waku falls back to the NODE adapter
  // (no CLOUDFLARE env var) which cannot run inside workerd — every request 500s.
  unstable_adapter: new URL("../src/adapter.cloudflare.ts", import.meta.url).pathname,
  vite: {
    environments: {
      rsc: { optimizeDeps: { include: ["hono/tiny"] } },
      ssr: { optimizeDeps: { include: ["waku > rsc-html-stream/server"] } },
    },
    plugins: [
      cloudflareVitePlugin({
        main: path.join(wakuDir, "dist/lib/vite-entries/entry.server.js"),
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        viteEnvironments: { entry: "rsc", children: ["ssr"] },
        worker: {
          name: "fixtures-spike-waku",
          bindings: [Text.local("MAX_ITEMS", "10")],
          assets: {
            htmlHandling: "drop-trailing-slash",
            notFoundHandling: "none",
          },
        },
      }),
    ],
  },
});

const server = await vite.createServer({
  configFile: false,
  root,
  plugins: [combinedPlugins(wakuConfig)],
  server: { port: 3211 },
});
await server.listen();
server.printUrls();
