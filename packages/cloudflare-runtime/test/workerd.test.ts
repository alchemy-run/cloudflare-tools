import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "../src/workerd/Runtime.ts";

const services = Layer.provide(Runtime.layer, NodeServices.layer);

layer(services)((it) => {
  it.effect("spawns a workerd process", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const result = yield* runtime.serve({
        sockets: [
          {
            name: "test",
            address: "localhost:0",
            service: { name: "test" },
          },
        ],
        services: [
          {
            name: "test",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [
                {
                  name: "main.js",
                  esModule: "export default { fetch: () => new Response('Hello, world!') };",
                },
              ],
            },
          },
        ],
      });
      expect(result).toMatchObject([
        {
          event: "listen",
          socket: "test",
          port: expect.any(Number),
        },
      ]);
    }),
  );

  it.effect("fails on invalid worker configuration", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const error = yield* runtime
        .serve({
          sockets: [
            {
              name: "test",
              address: "localhost:0",
              service: { name: "test" },
            },
          ],
          services: [
            {
              name: "test",
              worker: {
                modules: [
                  {
                    name: "main.js",
                    esModule: "export default { fetch: () => new Response('Hello, world!') };",
                  },
                ],
              },
            },
          ],
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "RuntimeError",
        message: "The Workers runtime failed to start.",
        stderr: "service test: Worker must specify compatibilityDate.",
      });
    }),
  );

  it.effect("fails on port conflict", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const result = yield* runtime.serve({
        sockets: [
          {
            name: "test",
            address: "localhost:0",
            service: { name: "test" },
          },
        ],
        services: [
          {
            name: "test",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [
                {
                  name: "main.js",
                  esModule: "export default { fetch: () => new Response('Hello, world!') };",
                },
              ],
            },
          },
        ],
      });
      const port = result[0].port;
      const error = yield* runtime
        .serve({
          sockets: [
            {
              name: "test",
              address: `localhost:${port}`,
              service: { name: "test" },
            },
          ],
          services: [
            {
              name: "test",
              worker: {
                compatibilityDate: "2026-03-10",
                modules: [
                  {
                    name: "main.js",
                    esModule: "export default { fetch: () => new Response('Hello, world!') };",
                  },
                ],
              },
            },
          ],
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("RuntimeError");
      expect(error.message).toBe("The Workers runtime failed to start.");
      // "*** Fatal uncaught kj::Exception: kj/async-io-unix.c++:945: failed: ::bind(sockfd, &addr.generic, addrlen): Address already in use; toString() = 127.0.0.1:61328\n" +
      //    "stack: 10505b7f7 10505b5db 10505a073 10277aadb 10277b2eb 10277bd2f 10277cf2f 1026f3d57 105086dff 105087127 10508599f 10508575f 1026e08db 18c753da3"
      expect(error.stderr).toMatch(/Address already in use/);
    }),
  );
});
