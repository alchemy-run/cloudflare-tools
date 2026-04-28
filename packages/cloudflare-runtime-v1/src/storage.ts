import type { Service } from "@distilled.cloud/workerd/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

export class Storage extends Context.Service<Storage, Service>()("Storage") {}

export const StorageLive = (filePath: string) =>
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(filePath, { recursive: true });
      return {
        name: "storage",
        disk: {
          path: filePath,
          writable: true,
          allowDotfiles: true,
        },
      } satisfies Service;
    }),
  );
