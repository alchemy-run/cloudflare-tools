import {
  makeDeployTarget,
  type DeployTarget,
  type DeployTargetServer,
} from "@distilled.cloud/framework-core";
import * as Miniflare from "@distilled.cloud/test-utils/miniflare";
import {
  moduleTypeFromExtension,
  type MiniflareModule,
} from "@distilled.cloud/test-utils/miniflare-module";
import * as Effect from "effect/Effect";
import { cast } from "effect/Function";
import * as Path from "effect/Path";
import type * as Options from "./Options.ts";

/**
 * The e2e harness's Cloudflare deploy target: a framework-core `DeployTarget`
 * value whose `serve` boots miniflare over a `BuildOutput` (the
 * preview-parity engine the harness has always used for `e2e preview` / the
 * Playwright `live` mode). Serving built output is *architecturally* the
 * target's concern — the implementation lives in the harness for now because
 * miniflare is a harness dependency.
 */
export interface CloudflareTarget extends DeployTarget<Options.CloudflareTargetOptions> {
  /** Always available on the harness's cloudflare target. */
  readonly serve: NonNullable<DeployTarget["serve"]>;
}

export const makeCloudflareTarget = (config: Options.CloudflareTargetOptions): CloudflareTarget =>
  makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    serve: (context) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const preview = config.preview ?? {};
        const build = context.output;
        const modules = build.serverModules?.flatMap(
          (module): MiniflareModule | Array<MiniflareModule> => {
            const type = moduleTypeFromExtension(path.extname(module.name));
            if (type === "SourceMap") {
              return [];
            }
            return {
              path: module.name,
              type,
              contents: module.content as string | Uint8Array<ArrayBuffer> | undefined,
            };
          },
        );
        const instance = yield* Effect.acquireDisposable(
          Effect.promise(
            async () =>
              await Miniflare.createMiniflare({
                ...preview,
                assets:
                  preview.assets && build.clientDirectory
                    ? {
                        ...preview.assets,
                        directory: build.clientDirectory,
                      }
                    : undefined,
                modules: modules ?? preview.modules ?? [],
              }),
          ),
        );
        return {
          url: instance.url.toString(),
          // miniflare's Response type differs nominally from the DOM's; the
          // harness has always cast across this boundary.
          fetch: cast<Miniflare.MiniflareInstance["fetch"], DeployTargetServer["fetch"]>(
            instance.fetch,
          ),
        };
      }),
  });
