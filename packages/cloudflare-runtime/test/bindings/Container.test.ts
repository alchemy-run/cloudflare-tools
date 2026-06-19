import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { execFileSync } from "node:child_process";
import * as DurableObjectNamespace from "../../src/bindings/DurableObjectNamespace.ts";
import { getFixture } from "../helpers/fixture.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const FIXTURE_DIR = getFixture("container");

// A Durable Object with an attached container. It starts the container and
// proxies the incoming request to the busybox httpd listening on port 8080.
const SCRIPT = (index: number) => `
import { DurableObject } from "cloudflare:workers";

export class MyContainer${index} extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container) {
      return new Response("no container binding", { status: 500 });
    }
    if (!container.running) {
      container.start();
    }
    const port = container.getTcpPort(8080);
    let lastError = "";
    for (let i = 0; i < 100; i++) {
      try {
        const res = await port.fetch("http://container/");
        if (res.ok) {
          return new Response(await res.text());
        }
        lastError = "status " + res.status;
      } catch (error) {
        lastError = String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return new Response("container not ready: " + lastError, { status: 504 });
  }
}

export default {
  async fetch(request, env) {
    const id = env.MY_CONTAINER.idFromName("singleton");
    return env.MY_CONTAINER.get(id).fetch(request);
  },
};
`;

const testContainer = Effect.fn(function* (index: number) {
  const path = yield* Path.Path;
  const worker = yield* startTestWorker({
    name: `container-binding-${index}`,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    bindings: [
      DurableObjectNamespace.local({
        binding: "MY_CONTAINER",
        className: `MyContainer${index}`,
      }),
    ],
    modules: [{ name: "main.js", type: "ESModule", content: SCRIPT(index) }],
    durableObjectNamespaces: [
      {
        className: `MyContainer${index}`,
        sql: true,
        container: {
          dockerfile: path.join(FIXTURE_DIR, "Dockerfile"),
          context: FIXTURE_DIR,
        },
      },
    ],
  });

  const text = yield* worker.fetchText("/");
  expect(text).toContain("hello from container");
}, Effect.scoped);

layer(localRuntimeLayer, { excludeTestServices: true })("Container binding", (it) => {
  it.effect.skipIf(!isDockerAvailable())(
    "builds a container image and proxies requests to it via ctx.container",
    () => testContainer(0),
    { concurrent: true, timeout: 30_000 },
  );

  it.effect.skipIf(!isDockerAvailable())(
    "proxies requests to multiple containers",
    () =>
      Effect.gen(function* () {
        yield* Effect.forEach(Array.from({ length: 10 }), (_, i) => testContainer(i + 1), {
          concurrency: "unbounded",
        });
      }),
    { concurrent: true, timeout: 30_000 },
  );
});

const isDockerAvailable = () => {
  try {
    execFileSync(process.env.DOCKER_BIN ?? "docker", ["info"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};
