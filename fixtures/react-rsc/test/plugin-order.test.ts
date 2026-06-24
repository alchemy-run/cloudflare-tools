import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Locks order-independence (review finding): with the Cloudflare plugin
// registered BEFORE rsc(), the rsc env's resolve.conditions lists `react-server`
// after the workerd conditions (not first). Export-condition resolution is
// set-membership, so the app must still render correctly — if `react-server`
// weren't effective in the rsc env, flight generation would 500. See
// vite.config.cf-first.ts.
const fixtureDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let proc: ChildProcess;
let baseUrl: string;

beforeAll(async () => {
  proc = spawn("bun", ["vite", "dev", "-c", "vite.config.cf-first.ts", "--port", "3152"], {
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

test("RSC renders correctly even with cloudflare() before rsc() (react-server not first in conditions)", async () => {
  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Vite + RSC");
  expect(html).toContain("Client Counter");
});
