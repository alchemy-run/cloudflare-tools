import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EntryWorker from "worker:./entry.worker.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import * as Cf from "./Cf.ts";
import * as Internet from "./Internet.ts";
import * as Storage from "./Storage.ts";

export class Globals extends Plugin.Service<Globals>()("cloudflare-runtime/plugin/Globals") {}

export const GlobalsLive = Layer.effect(
  Globals,
  Effect.gen(function* () {
    const internet = yield* Internet.Internet;
    const storage = yield* Storage.Storage;
    const cf = yield* Cf.Cf;
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
            modules: formatInternalWorkerModules(yield* Effect.promise(EntryWorker.worker)),
            bindings: [{ name: "CF_BLOB", json: JSON.stringify(cf) }],
          },
          upstreamBindingName: "USER_WORKER",
        },
      ],
      services: [internet, storage],
    });
  }),
);
