import { Layer } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { Service } from "./runtime/config.types";

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
