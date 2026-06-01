import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Port from "../src/internal/Port.ts";
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
      expect(error.subtag).toBe("AddressInUse");
      assert(Predicate.hasProperty(error.detail, "stderr"));
      // "*** Fatal uncaught kj::Exception: kj/async-io-unix.c++:945: failed: ::bind(sockfd, &addr.generic, addrlen): Address already in use; toString() = 127.0.0.1:61328\n" +
      //    "stack: 10505b7f7 10505b5db 10505a073 10277aadb 10277b2eb 10277bd2f 10277cf2f 1026f3d57 105086dff 105087127 10508599f 10508575f 1026e08db 18c753da3"
      expect(error.detail.stderr).toMatch(/Address already in use/);
      assert(Predicate.hasProperty(error.detail, "address"));
      expect(error.detail.address).toBe(`127.0.0.1:${port}`);
      expect(error.message).toContain(`127.0.0.1:${port}`);
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
            sockets: [{ name: "http", address: "127.0.0.1:0", service: { name: "test" } }],
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

        // Wait until we can bind to the port ourselves.

        const free = yield* Port.check(port).pipe(Effect.exit);
        assert(Exit.isSuccess(free));
      }),
    { timeout: 60_000 },
  );
});
