import { Miniflare } from "miniflare";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { AdditionalModule, BuildResult, ModuleType } from "../src/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Assertion {
  path: string;
  mode: "text" | "json";
  expected: unknown;
}

export interface WranglerConfig {
  name?: string;
  main: string;
  compatibility_date?: string;
  compatibility_flags?: Array<string>;
  rules?: Array<{
    type: string;
    globs: Array<string>;
    fallthrough?: boolean;
  }>;
  define?: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

/** Strip single-line // comments and trailing commas from JSONC */
function stripJsonc(text: string): string {
  // Remove single-line comments (not inside strings — good enough for config files)
  let result = text.replace(/^\s*\/\/.*$/gm, "");
  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, "$1");
  return result;
}

export function readFixtureConfig(fixturePath: string): WranglerConfig {
  const absPath = resolve(fixturePath);
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const p = join(absPath, name);
    if (existsSync(p)) {
      return JSON.parse(stripJsonc(readFileSync(p, "utf-8")));
    }
  }
  throw new Error(`No wrangler.json(c) found in ${absPath}`);
}

// ---------------------------------------------------------------------------
// Miniflare options derived from config
// ---------------------------------------------------------------------------

export function miniflareOptionsFromConfig(config: WranglerConfig) {
  return {
    compatibilityDate: config.compatibility_date ?? "2024-12-30",
    compatibilityFlags: config.compatibility_flags ?? [],
  };
}

// ---------------------------------------------------------------------------
// Bundle with Wrangler (oracle)
// ---------------------------------------------------------------------------

export function bundleWithWrangler(fixturePath: string): BuildResult {
  const absFixture = resolve(fixturePath);
  const outDir = join(absFixture, ".wrangler-test-out");

  // Clean previous output
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true });
  }
  mkdirSync(outDir, { recursive: true });

  // Run wrangler with NODE_ENV=production to match real deploy behavior
  // (vitest sets NODE_ENV=test which would leak into process.env.NODE_ENV defines)
  execSync(`npx wrangler deploy --dry-run --outdir "${outDir}"`, {
    cwd: absFixture,
    stdio: "pipe",
    timeout: 30_000,
    env: { ...process.env, NODE_ENV: "production" },
  });

  return loadWranglerOutput(outDir);
}

// ---------------------------------------------------------------------------
// Load Wrangler's --outdir output into BuildResult
// ---------------------------------------------------------------------------

export function loadWranglerOutput(outDir: string): BuildResult {
  const files = readdirSync(outDir);

  // Find the entry JS file (not a .map, not README)
  const entryFile = files.find(
    (f) =>
      f.endsWith(".js") &&
      !f.endsWith(".map") &&
      // Wrangler's additional modules get SHA1 prefixes; the entry does not
      !f.match(/^[0-9a-f]{40}-/),
  );
  if (!entryFile) {
    throw new Error(
      `No entry JS file found in wrangler output: ${outDir}\nFiles: ${files.join(", ")}`,
    );
  }

  const code = readFileSync(join(outDir, entryFile), "utf-8");

  // Source map
  const mapFile = `${entryFile}.map`;
  const sourceMap = files.includes(mapFile)
    ? readFileSync(join(outDir, mapFile), "utf-8")
    : undefined;

  // Additional modules — everything except the entry, its source map, and README
  const skipFiles = new Set([entryFile, mapFile, "README.md"]);
  const additionalModules: Array<AdditionalModule> = files
    .filter((f) => !skipFiles.has(f))
    .map((f) => ({
      name: f,
      type: inferModuleType(f),
      content: readModuleContent(join(outDir, f), inferModuleType(f)),
    }));

  return { entryPoint: entryFile, code, additionalModules, sourceMap };
}

// ---------------------------------------------------------------------------
// Module type inference from file extension
// ---------------------------------------------------------------------------

function inferModuleType(filename: string): ModuleType {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".wasm":
      return "CompiledWasm";
    case ".txt":
    case ".html":
    case ".sql":
      return "Text";
    case ".bin":
      return "Data";
    case ".js":
    case ".mjs":
      return "ESModule";
    case ".cjs":
      return "CommonJS";
    default:
      return "Data";
  }
}

function readModuleContent(path: string, type: ModuleType): string | Uint8Array {
  switch (type) {
    case "Text":
    case "ESModule":
    case "CommonJS":
      return readFileSync(path, "utf-8");
    default:
      return new Uint8Array(readFileSync(path));
  }
}

// ---------------------------------------------------------------------------
// Run a BuildResult in Miniflare
// ---------------------------------------------------------------------------

export async function createWorker(
  result: BuildResult,
  config: WranglerConfig,
): Promise<Miniflare> {
  const mfOptions = miniflareOptionsFromConfig(config);

  return new Miniflare({
    ...mfOptions,
    modules: [
      {
        type: "ESModule" as const,
        path: result.entryPoint,
        contents: result.code,
      },
      ...result.additionalModules.map((m) => ({
        type: m.type,
        path: m.name,
        contents: m.content,
      })),
    ],
  });
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function fetchText(mf: Miniflare, path: string): Promise<string> {
  const res = await mf.dispatchFetch(`http://localhost${path}`);
  return res.text();
}

export async function fetchJson(mf: Miniflare, path: string): Promise<unknown> {
  const res = await mf.dispatchFetch(`http://localhost${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Run all assertions for a fixture
// ---------------------------------------------------------------------------

export async function runAssertions(
  mf: Miniflare,
  assertions: Array<Assertion>,
): Promise<Array<{ path: string; pass: boolean; expected: unknown; actual: unknown }>> {
  const results: Array<{ path: string; pass: boolean; expected: unknown; actual: unknown }> = [];
  for (const assertion of assertions) {
    const actual =
      assertion.mode === "json"
        ? await fetchJson(mf, assertion.path)
        : await fetchText(mf, assertion.path);
    results.push({
      path: assertion.path,
      pass: JSON.stringify(actual) === JSON.stringify(assertion.expected),
      expected: assertion.expected,
      actual,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

export function cleanupWranglerOutput(fixturePath: string): void {
  const outDir = join(resolve(fixturePath), ".wrangler-test-out");
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true });
  }
  // Also clean up wrangler's .wrangler directory
  const wranglerDir = join(resolve(fixturePath), ".wrangler");
  if (existsSync(wranglerDir)) {
    rmSync(wranglerDir, { recursive: true });
  }
}
