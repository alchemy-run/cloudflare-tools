import type { CloudflareOptions } from "./bundle.js";

export function deriveDefines(
  options: Pick<CloudflareOptions, "compatibilityDate" | "define">,
): Record<string, string> {
  return {
    "process.env.NODE_ENV": '"production"',
    "global.process.env.NODE_ENV": '"production"',
    "globalThis.process.env.NODE_ENV": '"production"',
    ...(options.compatibilityDate && options.compatibilityDate >= "2022-03-21"
      ? { "navigator.userAgent": '"Cloudflare-Workers"' }
      : {}),
    ...options.define,
  };
}

export function deriveConditions(): Array<string> {
  return ["workerd", "worker", "browser"];
}

export function deriveFormat(format?: "modules" | "service-worker"): "esm" | "iife" {
  return format === "service-worker" ? "iife" : "esm";
}

export function deriveLoader(): Record<string, "jsx"> {
  return {
    ".js": "jsx",
    ".mjs": "jsx",
    ".cjs": "jsx",
  };
}
