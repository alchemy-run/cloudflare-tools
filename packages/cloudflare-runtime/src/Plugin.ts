import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Worker } from "./Worker.ts";
import type * as Config from "./workerd/Config.ts";

export const Service = <Self, P extends Plugin<any>>() => Context.Service<Self, P>();

export interface Plugin<out E = never> {
  readonly name: string;
  readonly make: (worker: Worker) => Effect.Effect<PluginOutput, E>;
}

export interface PluginOutput {
  middlewares?: Array<Middleware>;
  bindings?: Array<Config.Worker_Binding>;
  services?: Array<Config.Service>;
  extensions?: Array<Config.Extension>;
}

export interface Middleware {
  name: string;
  worker: Config.Worker;
  upstreamBindingName: string;
}

export const build = Effect.fn(function* <E = never>(worker: Worker, plugins: Array<Plugin<E>>) {
  const outputs = yield* Effect.all(plugins.map((plugin) => plugin.make(worker)));
  const services = outputs.flatMap((output) => output.services ?? []);
  const bindings = outputs.flatMap((output) => output.bindings ?? []);
  const extensions = outputs.flatMap((output) => output.extensions ?? []);
  const middlewares = outputs.flatMap((output) => output.middlewares ?? []);
  return {
    bindings,
    entry: middlewares[0]?.name ?? "user",
    services: [
      ...services,
      ...middlewares.map((middleware, index) => ({
        name: middleware.name,
        worker: {
          ...middleware.worker,
          bindings: [
            ...(middleware.worker.bindings ?? []),
            {
              name: middleware.upstreamBindingName,
              service: {
                name: index < middlewares.length - 1 ? middlewares[index + 1].name : "user",
              },
            },
          ],
        },
      })),
    ],
    extensions,
  };
});
