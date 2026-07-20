/**
 * Shared AstroInlineConfig for the spike scripts. Fully in-memory —
 * `configFile: false`, no astro.config.*, no wrangler.json.
 */
import * as Assets from "@distilled.cloud/cloudflare-runtime/bindings/assets/Assets";
import * as Text from "@distilled.cloud/cloudflare-runtime/bindings/Text";
import type { AstroInlineConfig } from "astro";
import * as path from "node:path";
import { distilledCloudflare } from "../integration.ts";

process.env.ASTRO_TELEMETRY_DISABLED = "1";

export const root = path.resolve(import.meta.dirname, "..");

export const SPIKE_VALUE = "hello-from-binding";

export const inlineConfig = (overrides?: Partial<AstroInlineConfig>): AstroInlineConfig => ({
  root,
  configFile: false,
  output: "server",
  logLevel: "info",
  adapter: distilledCloudflare({
    vite: {
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      worker: {
        name: "spike-astro",
        bindings: [Assets.local("ASSETS"), Text.local("SPIKE_VALUE", SPIKE_VALUE)],
        assets: {
          htmlHandling: "auto-trailing-slash",
          notFoundHandling: "none",
        },
      },
    },
  }),
  ...overrides,
});
