import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { execFileSync } from "node:child_process";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as DurableObjectNamespace from "../../src/bindings/DurableObjectNamespace.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

/**
 * Whether a usable Docker daemon is reachable. Container tests are skipped
 * when it is not, so the suite stays green on machines without Docker.
 */
const isDockerAvailable = (): boolean => {
  if (process.platform === "win32") {
    return false;
  }
  try {
    execFileSync(process.env.WRANGLER_DOCKER_BIN ?? "docker", ["info"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

const dockerAvailable = isDockerAvailable();

const fixtureDir = fileURLToPath(new URL("./container-fixture", import.meta.url));

// A Durable Object with an attached container. It starts the container and
// proxies the incoming request to the busybox httpd listening on port 8080.
const SCRIPT = `
import { DurableObject } from "cloudflare:workers";

export class MyContainer extends DurableObject {
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

layer(localRuntimeLayer)("Container binding", (it) => {
  it.effect.skipIf(!dockerAvailable)(
    "builds a container image and proxies requests to it via ctx.container",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "container-binding",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "MY_CONTAINER",
              className: "MyContainer",
            }),
          ],
          modules: [{ name: "main.js", type: "ESModule", content: SCRIPT }],
          durableObjectNamespaces: [
            {
              className: "MyContainer",
              sql: true,
              container: {
                dockerfile: NodePath.join(fixtureDir, "Dockerfile"),
                context: fixtureDir,
              },
            },
          ],
        });

        const text = yield* worker.fetchText("/");
        expect(text).toContain("hello from container");
      }),
    { timeout: 180_000 },
  );
});
