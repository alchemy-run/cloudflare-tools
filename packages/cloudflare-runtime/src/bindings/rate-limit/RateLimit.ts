import * as Layer from "effect/Layer";
import * as RateLimitBindingWorker from "worker:./RateLimitBinding.worker.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import type { RateLimitProps } from "./RateLimitProps.shared.ts";

export class RateLimit extends Plugin.Service<RateLimit>()("cloudflare-runtime/plugin/RateLimit") {}

export const RateLimitLive = Layer.succeed(
  RateLimit,
  RateLimit.of({
    extensions: [
      {
        modules: [
          {
            name: "cloudflare-runtime:rate-limit",
            internal: true,
            esModule: RateLimitBindingWorker.modules[0].content as string,
          },
        ],
      },
    ],
  }),
);

export const local = (props: RateLimitProps): BindingHook<RateLimit> =>
  Plugin.useSync(RateLimit, () => ({
    name: props.name,
    wrapped: {
      moduleName: "cloudflare-runtime:rate-limit",
      innerBindings: [
        {
          name: "PROPS",
          json: JSON.stringify(props),
        },
      ],
    },
  }));
