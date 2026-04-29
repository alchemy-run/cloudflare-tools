import * as Effect from "effect/Effect";
import * as EntryWorker from "worker:./entry.worker.ts";
import type { Plugin } from "../Plugin.ts";
import * as WorkerModule from "../WorkerModule.ts";

export const EntryPlugin: Plugin = {
  name: "entry",
  make: Effect.fn(function* () {
    return {
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
            modules: EntryWorker.modules.map(WorkerModule.toWorkerd),
          },
          upstreamBindingName: "USER_WORKER",
        },
      ],
    };
  }),
};
