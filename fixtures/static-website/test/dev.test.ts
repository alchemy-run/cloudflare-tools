import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let proc: ChildProcess;
let baseUrl: string;

test.beforeAll(async () => {
  proc = spawn("bun", ["vite", "dev", "--host", "127.0.0.1", "--port", "3351"], {
    cwd: fixtureDir,
    env: { ...process.env, DISTILLED_STATIC_WEBSITE_WORKER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dev server did not start in time")), 90_000);
    const onData = (chunk: Buffer) => {
      const match = String(chunk).match(/Local:\s+(http:\/\/\S+?)\/?\s/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1].replace(/\/$/, ""));
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`dev server exited early (code ${code})`)));
  });
});

test.afterAll(() => {
  proc?.kill("SIGTERM");
});

test("dev server serves Vite HTML assets before falling through to the Worker", async ({
  request,
}) => {
  const home = await request.get(`${baseUrl}/`);
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain('/src/main.ts"');

  const html = await request.get(`${baseUrl}/index.html`);
  expect(html.status()).toBe(200);
  expect(await html.text()).toContain('/src/main.ts"');

  const api = await request.get(`${baseUrl}/api/test`);
  expect(api.status()).toBe(200);
  expect(await api.json()).toEqual({ name: "Cloudflare" });
});
