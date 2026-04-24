import type { Service } from "@distilled.cloud/workerd/Config";
import * as Effect from "effect/Effect";
import * as Bundle from "../utils/bundle.ts";

export const Entry = Effect.gen(function* () {
  return {
    name: "entry",
    worker: {
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [
        "experimental",
        "enable_request_signal",
        "service_binding_extra_handlers",
      ],
      modules: yield* Bundle.bundle("src/entry/entry.worker.ts").pipe(
        Effect.flatMap(Bundle.bundleOutputToWorkerd),
      ),
      bindings: [{ name: "USER_WORKER", service: { name: "user" } }],
    },
  } satisfies Service;
});
