import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Dev-mode smoke test: boots `vite dev` (the distilled Cloudflare plugin in
// RSC mode) and asserts the RSC routes, routing, and the worker-loaded ssr
// render all respond. Build-mode tests are intentionally absent — RSC build
// is a separate track.
const fixtureDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let proc: ChildProcess;
let baseUrl: string;

beforeAll(async () => {
  proc = spawn("bun", ["vite", "dev", "--port", "3251"], {
    cwd: fixtureDir,
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

afterAll(() => {
  proc?.kill("SIGTERM");
});

test("renders the RSC home route", async () => {
  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("React Router Vite");
});

test("routes to /about", async () => {
  const res = await fetch(`${baseUrl}/about`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("About");
});

test("worker loads a custom ssr module via loadModule (react-dom/server in ssr env)", async () => {
  const res = await fetch(`${baseUrl}/worker-render`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; html: string };
  expect(body.ok).toBe(true);
  expect(body.html).toContain("Worker render via the ssr environment.");
});
