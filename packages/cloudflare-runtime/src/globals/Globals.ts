import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EntryWorker from "worker:./entry.worker.ts";
import * as Plugin from "../Plugin.ts";
import { moduleToWorkerd } from "../RuntimeWorker.ts";
import * as Internet from "./Internet.ts";
import * as Storage from "./Storage.ts";

export class Globals extends Plugin.Service<Globals>()("cloudflare-runtime/plugin/Globals") {}

export const GlobalsLive = Layer.effect(
  Globals,
  Effect.gen(function* () {
    const internet = yield* Internet.Internet;
    const storage = yield* Storage.Storage;
    return Globals.of({
      middlewares: [
        {
          name: "plugin:entry",
          worker: {
            compatibilityDate: "2026-03-10",
            compatibilityFlags: [
              "experimental",
              "enable_request_signal",
              "service_binding_extra_handlers",
            ],
            modules: EntryWorker.modules.map(moduleToWorkerd),
          },
          upstreamBindingName: "USER_WORKER",
        },
      ],
      services: [internet, storage],
    });
  }),
);
