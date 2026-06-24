import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Dev-mode smoke test: boots `vite dev` (the distilled Cloudflare plugin in
// RSC mode) and asserts the minimal RSC app renders — server components,
// the client component, and the server action are all present in the SSR'd
// HTML. Build-mode is a separate track and intentionally not tested here.
const fixtureDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let proc: ChildProcess;
let baseUrl: string;

beforeAll(async () => {
  proc = spawn("bun", ["vite", "dev", "--port", "3151"], {
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

test("server-renders the RSC app (server component + client component + server action)", async () => {
  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Vite + RSC"); // server component
  expect(html).toContain("Client Counter"); // client component
  expect(html).toContain("Server Counter"); // server action
});
