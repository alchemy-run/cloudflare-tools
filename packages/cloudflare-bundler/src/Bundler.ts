import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type { BundleError } from "./Error.js";
import type { Input } from "./Input.js";
import type { Output } from "./Output.js";

export class Bundler extends ServiceMap.Service<
  Bundler,
  {
    readonly build: (options: Input) => Effect.Effect<Output, BundleError>;
  }
>()("@distilled.cloud/cloudflare-bundler/Bundler") {}
