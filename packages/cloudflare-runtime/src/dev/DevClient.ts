import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import * as DevServer from "./DevServer.ts";
import * as Lock from "./Lock.ts";
import * as Rpc from "./Rpc.ts";

function resolve(path: string) {
  return fileURLToPath(import.meta.resolve(path, import.meta.url));
}

const scope = Scope.makeUnsafe();

process.on("SIGINT", async () => {
  console.log("SIGINT");
  await Effect.runPromise(Scope.close(scope, Exit.void));
  console.log("SIGINT done");
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM");
  await Effect.runPromise(Scope.close(scope, Exit.void));
  console.log("SIGTERM done");
});

export const DevClient = Effect.gen(function* () {
  const lock = yield* Lock.Lock;
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* lock.check)) {
    yield* ChildProcess.make("bun", ["run", resolve("./DevEntry.ts")], {
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
  }
  const client = yield* fs.readFileString(".cache/local/address.txt").pipe(
    Effect.flatMap((address) => Rpc.client<DevServer.DevServer>(address, DevServer.RpcSchema)),
    Effect.retry({}),
  );
  yield* client
    .heartbeat()
    .pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(4000))),
      Effect.ensuring(Effect.ignore(client.shutdown())),
      Effect.forkScoped,
      Scope.provide(scope),
    );
  return client;
}).pipe(Effect.provide(Lock.LockLive));
