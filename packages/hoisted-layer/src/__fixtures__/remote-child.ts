import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Counter, CounterLive } from "./shared.ts";

const program = Effect.gen(function* () {
  const counter = yield* Counter;
  const doubled = yield* counter.double(21);
  const countdown = yield* counter.countdown(3).pipe(
    Stream.runCollect,
    Effect.map((values) => Array.from(values as Iterable<number>)),
  );

  return {
    doubled,
    countdown,
  };
}).pipe(Effect.provide(Counter.hoisted({ fallback: CounterLive })));

Effect.runPromise(program as any)
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
