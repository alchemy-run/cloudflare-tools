/**
 * Dev v2 ("hmr" mode) spec: drives the `@distilled.cloud/nextjs` Framework
 * service directly (the harness's `dev` fixture is wired to the default
 * "preview" mode via e2e.config.ts, so this spec builds its own layer) and
 * exercises:
 *
 * - the page serves through the real `next dev` (Turbopack) server
 * - `getCloudflareContext().env` sees a binding value in SSR output —
 *   without `initOpenNextCloudflareForDev()` and without wrangler
 * - an edit to a page file is reflected on a subsequent request (bounded
 *   Effect retry; the file is restored in a finally)
 */
import { Text } from "@distilled.cloud/cloudflare-runtime/bindings";
import { Framework } from "@distilled.cloud/framework-core";
import nextjsFramework from "@distilled.cloud/nextjs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, test } from "@playwright/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const probePage = NodePath.join(root, "app", "hmr-probe", "page.jsx");

const layer = nextjsFramework({
  root,
  dev: { mode: "hmr" },
  vite: {
    compatibilityDate: "2026-05-12",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    worker: {
      name: "fixtures-nextjs-hmr",
      bindings: [Text.local("TEST_TEXT", "hello-from-binding")],
    },
  },
}).pipe(Layer.provideMerge(NodeServices.layer));

const runtime = ManagedRuntime.make(layer);
let scope: Scope.Scope.Closeable;
let url: URL;

/** GET `path` until `predicate(body)` holds — bounded, Effect-scheduled. */
const pollText = (
  path: string,
  predicate: (body: string) => boolean,
  { times = 60 }: { times?: number } = {},
): Promise<string> =>
  runtime.runPromise(
    Effect.tryPromise(async () => {
      const response = await fetch(new URL(path, url));
      const body = await response.text();
      if (response.status !== 200 || !predicate(body)) {
        throw new Error(
          `not ready (status ${response.status}): ${body.slice(0, 500).replace(/\n/g, " ")}`,
        );
      }
      return body;
    }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times })),
  );

test.beforeAll(async () => {
  // Cold `next dev` prepare + first Turbopack compile can be slow.
  test.setTimeout(300_000);
  scope = Scope.makeUnsafe();
  const server = await runtime.runPromise(
    Framework.use((framework) => framework.dev({ root })).pipe(Scope.provide(scope)),
  );
  url = new URL(server.url);
});

test.afterAll(async () => {
  if (scope !== undefined) {
    await runtime.runPromise(Scope.close(scope, Exit.void));
  }
  await runtime.dispose();
});

test.describe("hmr dev mode", () => {
  test("serves the SSR page through next dev", async () => {
    const body = await pollText("/", (b) => b.includes("fixtures-nextjs SSR page"));
    expect(body).toContain("rendered-at:");
  });

  test("getCloudflareContext().env binding is visible in SSR output", async () => {
    const body = await pollText("/hmr-probe", (b) => b.includes("hmr-binding:"));
    // React may render an empty comment between adjacent text nodes.
    expect(body).toMatch(/hmr-binding:(?:<!-- -->)?hello-from-binding/);
    expect(body).toContain("marker:v1");
  });

  test("reads a Text binding through getCloudflareContext in an API route", async () => {
    const response = await fetch(new URL("/api/binding", url));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { value: string | null };
    expect(json.value).toBe("hello-from-binding");
  });

  test("reflects a page edit on a subsequent request", async () => {
    test.setTimeout(180_000);
    // Warm the page first so the edit is an incremental recompile.
    await pollText("/hmr-probe", (b) => b.includes("marker:v1"));
    const original = await NodeFs.readFile(probePage, "utf8");
    try {
      await NodeFs.writeFile(probePage, original.replace("marker:v1", "marker:v2"), "utf8");
      const body = await pollText("/hmr-probe", (b) => b.includes("marker:v2"), { times: 120 });
      expect(body).toContain("marker:v2");
    } finally {
      await NodeFs.writeFile(probePage, original, "utf8");
    }
    // The restore is picked up too (leaves the tree clean for other specs).
    await pollText("/hmr-probe", (b) => b.includes("marker:v1"), { times: 120 });
  });
});
