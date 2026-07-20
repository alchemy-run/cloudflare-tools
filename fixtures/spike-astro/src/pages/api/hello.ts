import { env } from "cloudflare:workers";

export const prerender = false;

export function GET() {
  return Response.json({
    value: (env as Record<string, unknown>).SPIKE_VALUE ?? null,
    hasAssetsBinding: typeof (env as Record<string, any>).ASSETS?.fetch === "function",
  });
}
