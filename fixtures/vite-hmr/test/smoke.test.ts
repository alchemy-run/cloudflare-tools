import * as Playwright from "@distilled.cloud/e2e/Playwright";
import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CLIENT_MARKER_FILE = fileURLToPath(new URL("../src/client-marker.ts", import.meta.url));
const SERVER_MARKER_FILE = fileURLToPath(new URL("../src/server-marker.ts", import.meta.url));

for (const mode of Playwright.SERVER_METHODS) {
  test.describe(mode, () => {
    const it = Playwright.make(mode);

    // ---- mode-shared smoke: the fixture pulls its weight in live mode too.

    it("loads the page and hydrates the counter", async ({ page, server }) => {
      const response = await page.goto(server.url.toString());
      expect(response?.status()).toBe(200);
      await expect(page.locator("#client-marker")).toHaveText("client-marker-v1");
      await expect(page.locator("#counter")).toHaveText("Count is 0");
      await page.click("#counter");
      await expect(page.locator("#counter")).toHaveText("Count is 1");
    });

    it("serves the worker API route", async ({ server }) => {
      const body = await server.fetchJson<{ marker: string }>("/api/marker");
      expect(body.marker).toBe("server-marker-v1");
    });

    it("serves static assets from public/", async ({ server }) => {
      const response = await server.fetch("/hello.txt");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("hello-from-public");
    });

    // ---- dev-only: edit propagation under the Cloudflare vite plugin.

    it("applies a client-module edit as a hot update that preserves state", async ({
      page,
      server,
    }) => {
      test.skip(mode === "live", "HMR is a dev-server behavior");

      await page.goto(server.url.toString());
      await expect(page.locator("#client-marker")).toHaveText("client-marker-v1");

      // Establish client state that only survives a HOT update: a full page
      // reload re-runs client.ts and resets the counter to 0.
      await page.click("#counter");
      await expect(page.locator("#counter")).toHaveText("Count is 1");

      const source = await readFile(CLIENT_MARKER_FILE, "utf8");
      const edited = source.replace('"client-marker-v1"', '"client-marker-v2"');
      expect(edited).not.toBe(source);
      try {
        await writeFile(CLIENT_MARKER_FILE, edited, "utf8");
        // Bounded: toHaveText polls until the explicit timeout.
        await expect(page.locator("#client-marker")).toHaveText("client-marker-v2", {
          timeout: 30_000,
        });
        // The proof of real HMR: the accept callback swapped the marker while
        // the module (and its counter state) stayed alive.
        await expect(page.locator("#counter")).toHaveText("Count is 1");
      } finally {
        await writeFile(CLIENT_MARKER_FILE, source, "utf8");
      }
      // Wait for the restore to land so later specs see a settled server.
      await expect(page.locator("#client-marker")).toHaveText("client-marker-v1", {
        timeout: 30_000,
      });
      await expect(page.locator("#counter")).toHaveText("Count is 1");
    });

    it("reflects a worker-module edit on a subsequent request", async ({ server }) => {
      test.skip(mode === "live", "edit propagation is a dev-server behavior");

      // Bounded poll: mid-update requests may fail while the module graph
      // invalidates; retry until the expected marker (or give up well inside
      // the test timeout).
      const pollFor = async (expected: string) => {
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            const body = await server.fetchJson<{ marker: string }>("/api/marker");
            if (body.marker === expected) return;
          } catch {
            // mid-update — retry
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error(`timed out waiting for /api/marker to serve "${expected}"`);
      };

      await pollFor("server-marker-v1");
      const source = await readFile(SERVER_MARKER_FILE, "utf8");
      const edited = source.replace('"server-marker-v1"', '"server-marker-v2"');
      expect(edited).not.toBe(source);
      try {
        await writeFile(SERVER_MARKER_FILE, edited, "utf8");
        await pollFor("server-marker-v2");
      } finally {
        await writeFile(SERVER_MARKER_FILE, source, "utf8");
      }
      // Wait for the restore to land so later specs see a settled server.
      await pollFor("server-marker-v1");
    });
  });
}
