import { Deferred } from "effect";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class LockError extends Schema.TaggedErrorClass<LockError>()("LockError", {
  reason: Schema.Literals(["Conflict", "Invalid", "Timeout", "PlatformError"]),
  message: Schema.String,
  cause: Schema.optional(Schema.DefectWithStack),
}) {}

export class Lock extends Context.Service<
  Lock,
  {
    readonly check: Effect.Effect<boolean>;
    readonly release: Effect.Effect<void, LockError>;
    readonly acquire: Effect.Effect<void, LockError, Scope.Scope>;
    readonly touch: Effect.Effect<void, LockError>;
    readonly monitor: Effect.Effect<void, LockError>;
  }
>()("Lock") {}

const STALE_THRESHOLD = 10 * 1000;
const LOCK_PATH = ".cache/local/process.lock";

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const lockPath = path.resolve(LOCK_PATH);

  const readLockFile = fs.readFileString(lockPath).pipe(
    Effect.mapError(
      (e) =>
        new LockError({
          reason: "PlatformError",
          message: "Failed to read lock file",
          cause: e,
        }),
    ),
    Effect.flatMap((text) => {
      const pid = Number.parseInt(text);
      return Number.isNaN(pid)
        ? Effect.fail(new LockError({ reason: "Invalid", message: "Lock file is invalid" }))
        : Effect.succeed(pid);
    }),
  );

  const isLockProcessAlive = readLockFile.pipe(
    Effect.flatMap((pid) =>
      Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    ),
    Effect.orElseSucceed(() => false),
  );

  const isLockFileStale = fs.stat(lockPath).pipe(
    Effect.map((stat) => {
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0));
      return mtime.getTime() < Date.now() - STALE_THRESHOLD;
    }),
    Effect.orElseSucceed(() => true),
  );

  const isLockValid = Effect.zipWith(
    isLockProcessAlive,
    isLockFileStale,
    (alive, stale) => alive && !stale,
    {
      concurrent: true,
    },
  );

  const makeLockFile = fs.makeDirectory(path.dirname(lockPath), { recursive: true }).pipe(
    Effect.flatMap(() => fs.writeFileString(lockPath, process.pid.toString(), { flag: "wx" })),
    Effect.mapError((e) =>
      e.reason._tag === "AlreadyExists"
        ? new LockError({ reason: "Conflict", message: "Lock already held by another process" })
        : new LockError({
            reason: "PlatformError",
            message: "Failed to create lock file",
            cause: e,
          }),
    ),
  );

  const assertOwnLock = readLockFile.pipe(
    Effect.flatMap((pid) =>
      pid === process.pid
        ? Effect.void
        : Effect.fail(
            new LockError({ reason: "Conflict", message: "Lock not held by this process" }),
          ),
    ),
  );

  const removeLock = fs.remove(lockPath, { force: true }).pipe(
    Effect.mapError(
      (e) =>
        new LockError({
          reason: "PlatformError",
          message: "Failed to remove lock file",
          cause: e,
        }),
    ),
  );

  const deferred = yield* Deferred.make<void>();
  const releaseLock = assertOwnLock.pipe(
    Effect.andThen(() => removeLock),
    Effect.tap(() => Deferred.complete(deferred, Effect.void)),
  );

  yield* Effect.addFinalizer(() => Effect.ignore(releaseLock));

  return Lock.of({
    check: isLockValid,
    release: releaseLock,
    acquire: makeLockFile.pipe(
      Effect.catchIf(
        (e) => e.reason === "Conflict",
        (e) =>
          isLockValid.pipe(
            Effect.flatMap((valid) =>
              valid ? Effect.fail(e) : removeLock.pipe(Effect.andThen(() => makeLockFile)),
            ),
          ),
      ),
      Effect.tap(() => Effect.log("acquired lock")),
    ),
    touch: assertOwnLock.pipe(
      Effect.flatMap(() => {
        const now = Date.now();
        return fs.utimes(lockPath, now, now).pipe(
          Effect.mapError(
            (e) =>
              new LockError({
                reason: "PlatformError",
                message: "Failed to update lock file",
                cause: e,
              }),
          ),
        );
      }),
    ),
    monitor: Effect.race(
      Effect.zip(
        assertOwnLock,
        isLockFileStale.pipe(
          Effect.flatMap((stale) =>
            stale
              ? Effect.fail(new LockError({ reason: "Timeout", message: "Lock file is stale" }))
              : Effect.void,
          ),
        ),
        { concurrent: true },
      ).pipe(Effect.repeat(Schedule.spaced(Duration.millis(STALE_THRESHOLD))), Effect.asVoid),
      Deferred.await(deferred),
    ),
  });
});

export const LockLive = Layer.effect(Lock, make);
