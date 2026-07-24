import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * `platform.caches` access path.
 *
 * - **live** (workerd): `platform.caches.default` is the real Cache API — the
 *   first request for a key computes and `put`s, the second is a cache hit.
 * - **dev** (Node SSR): the stub platform's no-op cache — `match` never hits,
 *   so every request reports `cached: false`. This is the documented phase-1
 *   dev seam until the cloudflare-runtime Node-side bindings proxy lands.
 */
export const GET: RequestHandler = async ({ platform, url }) => {
  const key = url.searchParams.get("key") ?? "default";
  const cache = platform?.caches?.default;
  if (cache === undefined) {
    return json({ supported: false, cached: false, key });
  }
  const cacheKey = `https://cache.fixture.invalid/${encodeURIComponent(key)}`;
  const hit = await cache.match(cacheKey);
  if (hit !== undefined) {
    return json({ supported: true, cached: true, key });
  }
  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ key }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
      },
    }),
  );
  return json({ supported: true, cached: false, key });
};
