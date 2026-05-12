import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { Service } from "../workerd/Config.ts";

export class Storage extends Context.Service<Storage, Service>()("Storage") {}

const make = (filePath: string): Service => ({
  name: "storage",
  disk: {
    path: filePath,
    writable: true,
    allowDotfiles: true,
  },
});

export const layerDisk = (filePath: string) =>
  Layer.effect(
    Storage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(filePath, { recursive: true });
      return make(filePath);
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
      return make(path);
    }),
  );
