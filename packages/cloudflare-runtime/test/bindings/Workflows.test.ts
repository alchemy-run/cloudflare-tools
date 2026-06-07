import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Workflows from "../../src/bindings/workflows/Workflows.ts";
import * as Globals from "../../src/globals/Globals.ts";
import * as Internet from "../../src/globals/Internet.ts";
import * as Storage from "../../src/globals/Storage.ts";
import * as Paths from "../../src/internal/Paths.ts";
import * as Runtime from "../../src/Runtime.ts";
import * as RuntimeServices from "../../src/RuntimeServices.ts";
import * as Workerd from "../../src/workerd/Workerd.ts";
import { localRuntimeLayer, startTestWorker, waitForRegistryEntry } from "../helpers/runtime.ts";

const WORKFLOW_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class MyWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do("i'm a step?", async () => "yes you are");
    return "I'm a output string";
  }
}
export default {
  async fetch(request, env) {
    const workflow = await env.MY_WORKFLOW.create({ id: "an-id" });
    return new Response(JSON.stringify(await workflow.status()));
  },
};
`;

const COMPLETE_STATUS =
  '{"status":"complete","__LOCAL_DEV_STEP_OUTPUTS":["yes you are"],"output":"I\'m a output string"}';

const persistenceRuntimeLayer = (directory: string) =>
  Runtime.RuntimeLive.pipe(
    Layer.provideMerge(RuntimeServices.layerLocalBindings()),
    Layer.provide(Globals.GlobalsLive),
    Layer.provideMerge(RuntimeServices.layerLoopback()),
    Layer.provide(Storage.layerDisk(directory)),
    Layer.provide(Internet.InternetLive),
    Layer.provideMerge(RuntimeServices.layerRegistry()),
    Layer.provide(Paths.PathsLive),
    Layer.provide(Workerd.WorkerdLive),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );

const runOnceAgainstStorage = (directory: string) =>
  Effect.gen(function* () {
    const { fetch } = yield* startTestWorker({
      name: "workflows-persist-test",
      compatibilityDate: "2024-11-20",
      compatibilityFlags: [],
      modules: [{ name: "main.js", type: "ESModule", content: WORKFLOW_SCRIPT }],
      bindings: [
        Workflows.local({
          binding: "MY_WORKFLOW",
          workflowName: "MY_WORKFLOW",
          className: "MyWorkflow",
        }),
      ],
    });

    const res = yield* fetch("/");
    yield* Effect.promise(() => res.text());

    const deadline = Date.now() + 5000;
    let text = "";
    while (Date.now() < deadline) {
      const r = yield* fetch("/");
      text = yield* Effect.promise(() => r.text());
      if (text === COMPLETE_STATUS) {
        return text;
      }
      yield* Effect.sleep("100 millis");
    }
    return text;
  }).pipe(Effect.provide(persistenceRuntimeLayer(directory)), Effect.scoped);

describe("Workflows binding", () => {
  // NOTE: this test uses `describe`/`it.effect` (not `layer(...)`), so it picks
  // up the @effect/vitest default `TestEnv` (TestClock + TestConsole). That
  // happens to work here because `runOnceAgainstStorage` provides its own
  // `Runtime.RuntimeLive` layer with a real Clock via `NodeServices.layer`.
  it.effect(
    "persists Workflow data on file-system between runs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "workflows-persist-" });

        const first = yield* runOnceAgainstStorage(tmp);
        expect(first).toBe(COMPLETE_STATUS);

        const persistDir = `${tmp}/workflows`;
        const names = yield* fs.readDirectory(persistDir);
        expect(names).toContain(encodeURIComponent("MY_WORKFLOW"));

        const second = yield* runOnceAgainstStorage(tmp);
        expect(second).toBe(COMPLETE_STATUS);
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );
});

const LIFECYCLE_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class LifecycleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do("first step", async () => "step-1-done");
    await step.do("long step", async () => {
      await scheduler.wait(500);
      return "long-step-done";
    });
    await step.do("third step", async () => "step-3-done");
    return "workflow-complete";
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "lifecycle-test";

    if (url.pathname === "/create") {
      const instance = await env.LIFECYCLE_WORKFLOW.create({ id });
      const status = await instance.status();
      return Response.json({ id: instance.id, status });
    }
    if (url.pathname === "/status") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    if (url.pathname === "/pause") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.pause();
      return Response.json(await instance.status());
    }
    if (url.pathname === "/resume") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.resume();
      return Response.json(await instance.status());
    }
    if (url.pathname === "/restart") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.restart();
      return Response.json(await instance.status());
    }
    if (url.pathname === "/terminate") {
      const instance = await env.LIFECYCLE_WORKFLOW.get(id);
      await instance.terminate();
      return Response.json(await instance.status());
    }
    return new Response("Not found", { status: 404 });
  },
};
`;

const startLifecycleWorker = () =>
  startTestWorker({
    name: "workflows-lifecycle-test",
    compatibilityDate: "2026-03-09",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: LIFECYCLE_SCRIPT }],
    bindings: [
      Workflows.local({
        binding: "LIFECYCLE_WORKFLOW",
        workflowName: "LIFECYCLE_WORKFLOW",
        className: "LifecycleWorkflow",
      }),
    ],
  });

const waitForStatus = (
  fetch: (path: string) => Effect.Effect<Response>,
  id: string,
  expected: string,
  timeoutMs = 10_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      const res = yield* fetch(`/status?id=${id}`);
      last = (yield* Effect.promise(() => res.json())) as Record<string, unknown>;
      if (last["status"] === expected) {
        return last;
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.die(
      `Timed out waiting for status "${expected}" - last status: ${JSON.stringify(last)}`,
    );
  });

const waitForStepOutput = (
  fetch: (path: string) => Effect.Effect<Response>,
  id: string,
  expected: string,
  timeoutMs = 10_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = yield* fetch(`/status?id=${id}`);
      const data = (yield* Effect.promise(() => res.json())) as {
        __LOCAL_DEV_STEP_OUTPUTS?: ReadonlyArray<string>;
      };
      if (data.__LOCAL_DEV_STEP_OUTPUTS?.includes(expected)) {
        return;
      }
      yield* Effect.sleep("100 millis");
    }
    throw new Error(`Timed out waiting for step output "${expected}"`);
  });

// `excludeTestServices: true` keeps the real wall-clock Clock. Without it,
// `@effect/vitest` provides a TestClock and `Effect.sleep` would block (since
// nothing advances the virtual clock). The workflow engine's `pause`/`restart`
// flow relies on a real timer firing in `workerd` for the in-flight step, and
// we observe it from Node by polling on the real clock.
layer(localRuntimeLayer, { excludeTestServices: true })("Workflows binding lifecycle", (it) => {
  it.effect(
    "pause and resume a running workflow",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startLifecycleWorker();
        const id = "pause-resume-test";

        const createRes = yield* fetch(`/create?id=${id}`);
        const createData = (yield* Effect.promise(() => createRes.json())) as {
          id: string;
        };
        expect(createData.id).toBe(id);

        yield* waitForStepOutput(fetch, id, "step-1-done");

        const pauseRes = yield* fetch(`/pause?id=${id}`);
        const pauseData = (yield* Effect.promise(() => pauseRes.json())) as Record<string, unknown>;
        expect(pauseData).toHaveProperty("status");

        yield* waitForStatus(fetch, id, "paused");

        const resumeRes = yield* fetch(`/resume?id=${id}`);
        const resumeData = (yield* Effect.promise(() => resumeRes.json())) as Record<
          string,
          unknown
        >;
        expect(resumeData).toHaveProperty("status");

        const final = yield* waitForStatus(fetch, id, "complete");
        expect(final["output"]).toBe("workflow-complete");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "terminate a running workflow",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startLifecycleWorker();
        const id = "terminate-test";

        const createRes = yield* fetch(`/create?id=${id}`);
        yield* Effect.promise(() => createRes.text());

        yield* waitForStepOutput(fetch, id, "step-1-done");

        const terminateRes = yield* fetch(`/terminate?id=${id}`);
        const terminateData = (yield* Effect.promise(() => terminateRes.json())) as Record<
          string,
          unknown
        >;
        expect(terminateData).toHaveProperty("status");

        yield* waitForStatus(fetch, id, "terminated");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "restart a running workflow",
    () =>
      Effect.gen(function* () {
        const { fetch } = yield* startLifecycleWorker();
        const id = "restart-test";

        const createRes = yield* fetch(`/create?id=${id}`);
        yield* Effect.promise(() => createRes.text());

        yield* waitForStepOutput(fetch, id, "step-1-done");

        const restartRes = yield* fetch(`/restart?id=${id}`);
        const restartData = (yield* Effect.promise(() => restartRes.json())) as Record<
          string,
          unknown
        >;
        expect(restartData).toHaveProperty("status");

        const final = yield* waitForStatus(fetch, id, "complete");
        expect(final["output"]).toBe("workflow-complete");
      }),
    { timeout: 30_000 },
  );
});

// Cross-instance test: a workflow defined by one `Runtime` (the owner) is
// invoked from a workflow binding declared in a *different* `Runtime` (the
// consumer). The consumer must NOT host its own Engine — instead, its
// wrapped binding is routed through the dev-registry proxy to the owner.
//
// This test runs both runtimes in-process by nesting two `Effect.provide(
// localRuntimeLayer)` blocks. They communicate via the on-disk dev
// registry, which we point at a temp dir via MINIFLARE_REGISTRY_PATH.

const CROSS_INSTANCE_OWNER_SCRIPT = `
import { WorkflowEntrypoint } from "cloudflare:workers";
export class CrossWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const first = await step.do("step-1", async () => "from-owner");
    return { ok: true, payload: first };
  }
}
export default {
  async fetch() {
    // Owner exposes no HTTP API; the consumer drives the workflow.
    return new Response("owner-alive");
  },
};
`;

const CROSS_INSTANCE_CONSUMER_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "cross-instance-test";
    if (url.pathname === "/create") {
      const instance = await env.CROSS_WORKFLOW.create({ id });
      return Response.json({ id: instance.id });
    }
    if (url.pathname === "/status") {
      const instance = await env.CROSS_WORKFLOW.get(id);
      return Response.json(await instance.status());
    }
    return new Response("not found", { status: 404 });
  },
};
`;

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Workflows binding cross-instance",
  (it) => {
    it.effect(
      "consumer binding routes to the owner's engine via the dev registry",
      () =>
        Effect.gen(function* () {
          // Owner: defines the WorkflowEntrypoint class and hosts the Engine.
          yield* startTestWorker({
            name: "cross-owner",
            compatibilityDate: "2026-03-09",
            compatibilityFlags: [],
            modules: [{ name: "main.js", type: "ESModule", content: CROSS_INSTANCE_OWNER_SCRIPT }],
            bindings: [
              Workflows.local({
                binding: "CROSS_WORKFLOW",
                workflowName: "CROSS_WORKFLOW",
                className: "CrossWorkflow",
              }),
            ],
          });

          // Consumer: declares the binding with `scriptName` pointing at
          // the owner. It does NOT define `CrossWorkflow`, so its Workflows
          // plugin must skip engine creation and route through the proxy.
          const consumer = yield* startTestWorker({
            name: "cross-consumer",
            compatibilityDate: "2026-03-09",
            compatibilityFlags: [],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: CROSS_INSTANCE_CONSUMER_SCRIPT,
              },
            ],
            bindings: [
              Workflows.local({
                binding: "CROSS_WORKFLOW",
                workflowName: "CROSS_WORKFLOW",
                className: "CrossWorkflow",
                scriptName: "cross-owner",
              }),
            ],
          });

          yield* waitForRegistryEntry({
            kind: "workflow",
            scriptName: "cross-owner",
            workflowName: "CROSS_WORKFLOW",
          });

          const id = "cross-instance-1";
          const createRes = yield* consumer.fetch(`/create?id=${id}`);
          expect(createRes.status).toBe(200);

          const deadline = Date.now() + 15_000;
          let final: Record<string, unknown> = {};
          while (Date.now() < deadline) {
            const res = yield* consumer.fetch(`/status?id=${id}`);
            final = (yield* Effect.promise(() => res.json())) as Record<string, unknown>;
            if (final["status"] === "complete") break;
            yield* Effect.sleep("100 millis");
          }
          expect(final["status"]).toBe("complete");
          expect(final["output"]).toEqual({ ok: true, payload: "from-owner" });
        }),
      { timeout: 60_000 },
    );
  },
);
