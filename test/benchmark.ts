// oxlint-disable no-console
/**
 * Bundle benchmark: measures build time and output size for each bundler × fixture combination.
 *
 * Usage:  bun test/benchmark.ts
 */
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import { bundleWithEsbuild } from "./harness/esbuild-bundler.js";
import { bundleWithRolldown } from "./harness/rolldown-bundler.js";
import { bundleWithRspack } from "./harness/rspack-bundler.js";
import { loadFixture } from "./harness/fixture.js";
import { bundleWithWrangler } from "./harness/wrangler-bundler.js";
import type { BundleConfig, BundleResult } from "./harness/types.js";

const fixtures = [
  "additional-modules",
  "build-conditions",
  "build-options",
  "cloudflare-externals",
  "cloudflare-submodules",
  "custom-define",
  "jsx-in-js",
  "module-rules",
  "module-rules-advanced",
  "named-exports",
  "navigator-user-agent",
  "node-env",
  "nodejs-compat",
  "nodejs-compat-warnings",
  "service-worker",
  "source-maps",
  "static-content-manifest",
  "tsconfig-paths",
];

const bundlers = [
  { name: "wrangler", fn: bundleWithWrangler },
  { name: "esbuild", fn: bundleWithEsbuild },
  { name: "rolldown", fn: bundleWithRolldown },
  { name: "rspack", fn: bundleWithRspack },
] as const;

interface BenchmarkEntry {
  fixture: string;
  bundler: string;
  timeMs: number;
  mainBytes: number;
  totalBytes: number;
  fileCount: number;
  error?: string;
}

function measureOutputSize(result: BundleResult): {
  mainBytes: number;
  totalBytes: number;
  fileCount: number;
} {
  const mainBytes = fs.existsSync(result.main) ? fs.statSync(result.main).size : 0;
  let totalBytes = mainBytes;
  let fileCount = 1;

  for (const mod of result.modules) {
    const size = mod.content
      ? mod.content.byteLength
      : fs.existsSync(mod.path)
        ? fs.statSync(mod.path).size
        : 0;
    totalBytes += size;
    fileCount++;
  }

  return { mainBytes, totalBytes, fileCount };
}

async function runBenchmark(
  fixture: string,
  bundlerName: string,
  bundlerFn: (c: BundleConfig) => Effect.Effect<BundleResult, any>,
): Promise<BenchmarkEntry> {
  try {
    const config = await Effect.runPromise(loadFixture(fixture));
    const start = performance.now();
    const result = await Effect.runPromise(bundlerFn(config));
    const timeMs = performance.now() - start;
    const { mainBytes, totalBytes, fileCount } = measureOutputSize(result);
    return { fixture, bundler: bundlerName, timeMs, mainBytes, totalBytes, fileCount };
  } catch (err) {
    return {
      fixture,
      bundler: bundlerName,
      timeMs: 0,
      mainBytes: 0,
      totalBytes: 0,
      fileCount: 0,
      error: String(err).slice(0, 80),
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}
function rpad(s: string, len: number): string {
  return s.padStart(len);
}

async function main() {
  const results: Array<BenchmarkEntry> = [];

  // Warmup: run esbuild once to JIT-warm the runtime
  console.log("Warming up...\n");
  try {
    const warmupConfig = await Effect.runPromise(loadFixture("node-env"));
    await Effect.runPromise(bundleWithEsbuild(warmupConfig));
    await Effect.runPromise(bundleWithRolldown(warmupConfig));
    await Effect.runPromise(bundleWithRspack(warmupConfig));
  } catch {
    /* ignore */
  }

  for (const fixture of fixtures) {
    process.stdout.write(`${fixture}: `);
    for (const { name, fn } of bundlers) {
      const entry = await runBenchmark(fixture, name, fn);
      results.push(entry);
      process.stdout.write(`${name}=${entry.error ? "ERR" : `${entry.timeMs.toFixed(0)}ms`} `);
    }
    process.stdout.write("\n");
  }

  // Print summary tables
  console.log("\n" + "=".repeat(120));
  console.log("BUILD TIME (ms)");
  console.log("=".repeat(120));

  const fW = 28;
  const bW = 14;
  const header = pad("fixture", fW) + bundlers.map((b) => rpad(b.name, bW)).join("");
  console.log(header);
  console.log("-".repeat(120));

  for (const fixture of fixtures) {
    const entries = bundlers.map(
      (b) => results.find((r) => r.fixture === fixture && r.bundler === b.name)!,
    );
    const line =
      pad(fixture, fW) +
      entries.map((e) => rpad(e.error ? "ERR" : `${e.timeMs.toFixed(0)}`, bW)).join("");
    console.log(line);
  }

  // Averages
  console.log("-".repeat(120));
  const avgLine =
    pad("AVERAGE", fW) +
    bundlers
      .map((b) => {
        const entries = results.filter((r) => r.bundler === b.name && !r.error);
        const avg = entries.reduce((sum, e) => sum + e.timeMs, 0) / (entries.length || 1);
        return rpad(avg.toFixed(0), bW);
      })
      .join("");
  console.log(avgLine);

  console.log("\n" + "=".repeat(120));
  console.log("MAIN BUNDLE SIZE");
  console.log("=".repeat(120));
  console.log(pad("fixture", fW) + bundlers.map((b) => rpad(b.name, bW)).join(""));
  console.log("-".repeat(120));

  for (const fixture of fixtures) {
    const entries = bundlers.map(
      (b) => results.find((r) => r.fixture === fixture && r.bundler === b.name)!,
    );
    const line =
      pad(fixture, fW) +
      entries.map((e) => rpad(e.error ? "ERR" : formatBytes(e.mainBytes), bW)).join("");
    console.log(line);
  }

  console.log("\n" + "=".repeat(120));
  console.log("TOTAL OUTPUT SIZE (main + modules)");
  console.log("=".repeat(120));
  console.log(pad("fixture", fW) + bundlers.map((b) => rpad(b.name, bW)).join(""));
  console.log("-".repeat(120));

  for (const fixture of fixtures) {
    const entries = bundlers.map(
      (b) => results.find((r) => r.fixture === fixture && r.bundler === b.name)!,
    );
    const line =
      pad(fixture, fW) +
      entries
        .map((e) => rpad(e.error ? "ERR" : `${formatBytes(e.totalBytes)} (${e.fileCount})`, bW))
        .join("");
    console.log(line);
  }

  // Averages
  console.log("-".repeat(120));
  const avgSizeLine =
    pad("AVERAGE", fW) +
    bundlers
      .map((b) => {
        const entries = results.filter((r) => r.bundler === b.name && !r.error);
        const avgTotal = entries.reduce((sum, e) => sum + e.totalBytes, 0) / (entries.length || 1);
        return rpad(`${formatBytes(avgTotal)}`, bW);
      })
      .join("");
  console.log(avgSizeLine);

  // Highlight outliers
  console.log("\n" + "=".repeat(120));
  console.log("OUTLIERS (rspack or rolldown significantly slower or larger than esbuild)");
  console.log("=".repeat(120));

  for (const fixture of fixtures) {
    const esbuildEntry = results.find((r) => r.fixture === fixture && r.bundler === "esbuild");
    if (!esbuildEntry || esbuildEntry.error) continue;

    for (const alt of ["rolldown", "rspack"] as const) {
      const altEntry = results.find((r) => r.fixture === fixture && r.bundler === alt);
      if (!altEntry || altEntry.error) continue;

      const timeRatio = altEntry.timeMs / esbuildEntry.timeMs;
      const sizeRatio = altEntry.mainBytes / esbuildEntry.mainBytes;

      if (timeRatio > 3) {
        console.log(
          `  ${fixture}: ${alt} is ${timeRatio.toFixed(1)}x SLOWER than esbuild (${altEntry.timeMs.toFixed(0)}ms vs ${esbuildEntry.timeMs.toFixed(0)}ms)`,
        );
      }
      if (sizeRatio > 2) {
        console.log(
          `  ${fixture}: ${alt} output is ${sizeRatio.toFixed(1)}x LARGER than esbuild (${formatBytes(altEntry.mainBytes)} vs ${formatBytes(esbuildEntry.mainBytes)})`,
        );
      }
    }
  }
}

main().catch(console.error);
