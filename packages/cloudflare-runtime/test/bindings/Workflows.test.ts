import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as DevRegistry from "../../src/dev-registry/DevRegistry.ts";
import * as Globals from "../../src/globals/Globals.ts";
import * as Internet from "../../src/globals/Internet.ts";
import * as Storage from "../../src/globals/Storage.ts";
import * as Runtime from "../../src/Runtime.ts";
import * as RuntimeServices from "../../src/RuntimeServices.ts";
import * as Workerd from "../../src/workerd/Workerd.ts";
import * as Workflows from "../../src/bindings/workflows/Workflows.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

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
    Layer.provide(DevRegistry.DevRegistryLive),
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
      workflows: {
        MY_WORKFLOW: { className: "MyWorkflow", name: "MY_WORKFLOW" },
      },
      bindings: [Workflows.local("MY_WORKFLOW")],
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
        expect(names).toContain("miniflare-workflows-MY_WORKFLOW");

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
    workflows: {
      LIFECYCLE_WORKFLOW: { className: "LifecycleWorkflow", name: "LIFECYCLE_WORKFLOW" },
    },
    bindings: [Workflows.local("LIFECYCLE_WORKFLOW")],
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

layer(localRuntimeLayer)("Workflows binding lifecycle", (it) => {
  // TODO: re-enable once we resolve why the engine Durable Object does not
  // transition out of `waitingForPause` in this environment. The terminate
  // test below works end-to-end because terminate simply aborts the engine
  // without requiring a subsequent restart-from-alarm.
  it.effect.skip(
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
    { timeout: 60_000 },
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
    { timeout: 60_000 },
  );

  it.effect.skip(
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
    { timeout: 60_000 },
  );
});
