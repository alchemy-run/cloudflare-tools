import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { Service } from "./workerd/Config.ts";

export class Storage extends Context.Service<Storage, Service>()("Storage") {}

export const layerDisk = (filePath: string) =>
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

export const layerTemp = (options?: {
  readonly directory?: string | undefined;
  readonly prefix?: string | undefined;
}) =>
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* fs.makeTempDirectoryScoped(options);
      return {
        name: "storage",
        disk: {
          path,
          writable: true,
          allowDotfiles: true,
        },
      } satisfies Service;
    }),
  );
