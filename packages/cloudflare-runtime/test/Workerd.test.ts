import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Net from "node:net";
import * as Workerd from "../src/workerd/Workerd.ts";

const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);

layer(services)((it) => {
  it.effect("spawns a workerd process", () =>
    Effect.gen(function* () {
      const workerd = yield* Workerd.Workerd;
      const result = yield* workerd.serve({
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
      expect(result).toMatchObject({
        test: expect.any(Number),
      });
    }),
  );

  it.effect("fails on invalid worker configuration", () =>
    Effect.gen(function* () {
      const workerd = yield* Workerd.Workerd;
      const error = yield* workerd
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
        _tag: "ConfigError",
        subtag: "WorkerdUserScript",
        message: "Worker must specify compatibilityDate.",
        detail: { service: "test", stderr: "service test: Worker must specify compatibilityDate." },
      });
    }),
  );

  it.effect("fails on port conflict", () =>
    Effect.gen(function* () {
      const workerd = yield* Workerd.Workerd;
      const result = yield* workerd.serve({
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
      const port = result.test;
      const error = yield* workerd
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
      assert.equal(error._tag, "ConfigError");
      expect(error.subtag).toBe("WorkerdAddressInUse");
      assert(Predicate.hasProperty(error.detail, "stderr"));
      // "*** Fatal uncaught kj::Exception: kj/async-io-unix.c++:945: failed: ::bind(sockfd, &addr.generic, addrlen): Address already in use; toString() = 127.0.0.1:61328\n" +
      //    "stack: 10505b7f7 10505b5db 10505a073 10277aadb 10277b2eb 10277bd2f 10277cf2f 1026f3d57 105086dff 105087127 10508599f 10508575f 1026e08db 18c753da3"
      expect(error.detail.stderr).toMatch(/Address already in use/);
    }),
  );

  it.effect(
    "returns a port for each named socket",
    () =>
      Effect.gen(function* () {
        const workerd = yield* Workerd.Workerd;
        const ports = yield* workerd.serve({
          sockets: [
            {
              name: "primary",
              address: "127.0.0.1:0",
              service: { name: "test" },
            },
            {
              name: "secondary",
              address: "127.0.0.1:0",
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
                    esModule: "export default { fetch: () => new Response('ok') };",
                  },
                ],
              },
            },
          ],
        });
        expect(ports.primary).toEqual(expect.any(Number));
        expect(ports.secondary).toEqual(expect.any(Number));
        expect(ports.primary).not.toEqual(ports.secondary);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "shuts down workerd when its scope closes",
    () =>
      Effect.gen(function* () {
        let port = 0;
        yield* Effect.gen(function* () {
          const workerd = yield* Workerd.Workerd;
          const ports = yield* workerd.serve({
            sockets: [
              { name: "http", address: "127.0.0.1:0", service: { name: "test" } },
            ],
            services: [
              {
                name: "test",
                worker: {
                  compatibilityDate: "2026-03-10",
                  modules: [
                    {
                      name: "main.js",
                      esModule: "export default { fetch: () => new Response('ok') };",
                    },
                  ],
                },
              },
            ],
          });
          port = ports.http;
          const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/`));
          expect(yield* Effect.promise(() => response.text())).toBe("ok");
        }).pipe(Effect.scoped);

        // Wait until we can bind to the port ourselves. If workerd is still
        // alive, listen() fails with EADDRINUSE. Try for up to 30 polls.
        const tryBind = () =>
          Effect.callback<boolean>((resume) => {
            const server = Net.createServer();
            const settle = (free: boolean) => {
              server.removeAllListeners();
              server.close();
              resume(Effect.succeed(free));
            };
            server.once("error", () => settle(false));
            server.once("listening", () => {
              server.close(() => settle(true));
            });
            server.listen(port, "127.0.0.1");
          });
        let free = false;
        for (let i = 0; i < 30; i++) {
          free = yield* tryBind();
          if (free) break;
          // Use real time even under TestClock (`it.effect`).
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));
        }
        expect(free).toBe(true);
      }),
    { timeout: 60_000 },
  );
});
