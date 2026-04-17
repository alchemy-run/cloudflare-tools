import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Counter, CounterLive } from "./__fixtures__/shared.ts";

const childPath = fileURLToPath(new URL("./__fixtures__/remote-child.ts", import.meta.url));

function runChild(env: Record<string, string>) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn("bun", ["run", childPath], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

describe("HoistedLayer", () => {
  it("falls back to the local layer when no remote address is configured", async () => {
    const result = (await Effect.runPromise(
      Effect.gen(function* () {
        const counter = yield* Counter;
        const doubled = yield* counter.double(10);
        const countdown = yield* counter.countdown(4).pipe(
          Stream.runCollect,
          Effect.map((values) => Array.from(values as Iterable<number>)),
        );

        return {
          doubled,
          countdown,
        };
      }).pipe(Effect.provide(Counter.hoisted({ fallback: CounterLive }))) as any,
    )) as { doubled: number; countdown: number[] };

    expect(result).toEqual({
      doubled: 20,
      countdown: [4, 3, 2, 1],
    });
  });

  it("uses the hosted rpc server from a child process", async () => {
    const result = (await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hosted = yield* Counter.host(CounterLive);
          return yield* Effect.promise(() => runChild(hosted.env));
        }),
      ) as any,
    )) as { stdout: string; stderr: string; exitCode: number | null };

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      doubled: 42,
      countdown: [3, 2, 1],
    });
  });
});
