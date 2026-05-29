import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Runtime from "../src/Runtime.ts";
import { localRuntimeLayer } from "./helpers/runtime.ts";

const HELLO_SCRIPT = `
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/hello") return new Response("hello");
    if (url.pathname === "/echo") return new Response(request.method);
    return new Response("not found", { status: 404 });
  }
};
`;

layer(localRuntimeLayer)("Runtime", (it) => {
  it.effect(
    "starts a worker and returns an http://127.0.0.1:<port> URL",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        const url = yield* runtime.start({
          name: "smoke",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [{ name: "main.js", type: "ESModule", content: HELLO_SCRIPT }],
        });
        expect(url).toBeInstanceOf(URL);
        expect(url.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        const hello = yield* Effect.promise(() => fetch(new URL("/hello", url)));
        expect(hello.status).toBe(200);
        expect(yield* Effect.promise(() => hello.text())).toBe("hello");
        const echo = yield* Effect.promise(() => fetch(new URL("/echo", url), { method: "POST" }));
        expect(yield* Effect.promise(() => echo.text())).toBe("POST");
      }),
    { timeout: 30_000 },
  );

  it.effect("surfaces user-script errors as ConfigError", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const error = yield* runtime
        .start({
          name: "broken",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: "this is not valid javascript ===",
            },
          ],
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConfigError");
    }),
  );
});
