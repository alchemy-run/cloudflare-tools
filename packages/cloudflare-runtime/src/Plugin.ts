import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { Worker } from "./Worker.ts";
import type * as Config from "./workerd/Config.ts";
import type { ControlMessage } from "./workerd/Runtime.ts";

export const Service = <Self, P extends Plugin<any>>() => Context.Service<Self, P>();

export interface Plugin<out E = never> {
  readonly name: string;
  readonly make: (worker: Worker) => Effect.Effect<PluginOutput, E>;
}

export interface PluginOutput {
  sockets?: Array<Config.Socket>;
  middlewares?: Array<Middleware>;
  bindings?: Array<Config.Worker_Binding>;
  services?: Array<Config.Service>;
  extensions?: Array<Config.Extension>;
  ready?: (messages: Array<ControlMessage>) => Effect.Effect<void, never, Scope.Scope>;
}

export interface Middleware {
  name: string;
  worker: Config.Worker;
  upstreamBindingName: string;
}

export const build = Effect.fn(function* <E = never>(worker: Worker, plugins: Array<Plugin<E>>) {
  const outputs = yield* Effect.all(plugins.map((plugin) => plugin.make(worker)));
  const sockets = outputs.flatMap((output) => output.sockets ?? []);
  const services = outputs.flatMap((output) => output.services ?? []);
  const bindings = outputs.flatMap((output) => output.bindings ?? []);
  const extensions = outputs.flatMap((output) => output.extensions ?? []);
  const middlewares = outputs.flatMap((output) => output.middlewares ?? []);
  const ready = outputs.flatMap((output) => output.ready ?? []);
  return {
    sockets,
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
    ready: (messages: Array<ControlMessage>) => Effect.all(ready.map((ready) => ready(messages))),
  };
});
