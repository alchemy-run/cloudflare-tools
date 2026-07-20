/**
 * Spike part 2 (THE RISK): astro dev() with our vite plugin on the ssr env.
 * Boots the dev server, asserts over HTTP, exits non-zero on failure.
 */
import { dev } from "astro";
import { inlineConfig } from "./config.ts";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
};

const server = await dev(inlineConfig({ server: { port: 43210, host: "127.0.0.1" } }));
const base = `http://127.0.0.1:${server.address.port}`;
console.log(`dev server at ${base} (resolvedUrls: ${JSON.stringify(server.resolvedUrls?.local)})`);

try {
  // give workerd + module runner a moment on first request; retry bounded
  const get = async (path: string, tries = 10): Promise<Response> => {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await fetch(`${base}${path}`, { redirect: "manual" });
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw last;
  };

  // 1. on-demand SSR page rendered inside workerd
  const home = await get("/");
  const homeText = await home.text();
  check(
    "on-demand SSR page",
    home.status === 200 && homeText.includes("Spike Astro") && homeText.includes("on-demand"),
    `status=${home.status} len=${homeText.length}`,
  );

  // 2. API endpoint reading a binding via cloudflare:workers
  const api = await get("/api/hello");
  const apiText = await api.text();
  let apiJson: any = null;
  try {
    apiJson = JSON.parse(apiText);
  } catch {
    /* not json */
  }
  check(
    "API route reads Text binding",
    api.status === 200 && apiJson?.value === "hello-from-binding",
    `status=${api.status} body=${apiText.slice(0, 200)}`,
  );
  check(
    "env.ASSETS binding exists in dev",
    apiJson?.hasAssetsBinding === true,
    `hasAssetsBinding=${apiJson?.hasAssetsBinding}`,
  );

  // 3. 404 fallback — handler.ts unconditionally calls env.ASSETS.fetch here.
  const missing = await get("/definitely-not-a-route");
  const missingText = await missing.text();
  check(
    "404 fallback (env.ASSETS.fetch path)",
    missing.status === 404,
    `status=${missing.status} body=${missingText.slice(0, 120).replace(/\n/g, " ")}`,
  );

  // 4. prerendered route in dev (node prerender middleware)
  const about = await get("/about/");
  const aboutText = await about.text();
  check(
    "prerendered route served in dev",
    about.status === 200 && aboutText.includes("prerendered"),
    `status=${about.status} len=${aboutText.length}`,
  );

  // 5. public asset via vite middleware
  const robots = await get("/robots.txt");
  const robotsText = await robots.text();
  check(
    "public/ asset",
    robots.status === 200 && robotsText.includes("User-agent"),
    `status=${robots.status}`,
  );

  // 6. HMR client is reachable (vite internal middlewares not shadowed)
  const viteClient = await get("/@vite/client");
  check("/@vite/client not shadowed", viteClient.status === 200, `status=${viteClient.status}`);
  await viteClient.arrayBuffer();
} finally {
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
