import { test } from "@playwright/test";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Runtime from "./Runtime.ts";
import * as Server from "./Server.ts";

export const SERVER_METHODS = ["live", "dev"] as const;
export type ServerMethod = (typeof SERVER_METHODS)[number];

export const make = (method: ServerMethod) =>
  test.extend<{}, { readonly server: Server.Instance }>({
    server: [
      // oxlint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const harness = await makeServerInstance(method);
        await use(harness);
        await harness.dispose();
      },
      { scope: "worker" },
    ],
  });

const makeServerInstance = async (method: ServerMethod) => {
  const scope = Scope.makeUnsafe();
  const runtime = ManagedRuntime.make(Runtime.layer);
  const instance = await runtime.runPromise(
    Server.Server.use((server) => server[method]()).pipe(Scope.provide(scope)),
  );
  await waitForListener(instance.url);
  return {
    ...instance,
    dispose: () => runtime.runPromise(Scope.close(scope, Exit.void)),
  };
};

// The server's readiness signal (miniflare's `ready`, vite's `listen`) can
// race the loopback listener actually accepting connections, which surfaces
// as net::ERR_CONNECTION_REFUSED on the test's first page.goto (seen on
// Windows CI). Any response status counts — we only need the socket to accept.
const waitForListener = async (url: URL) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Server at ${url} did not accept connections`, { cause: lastError });
};
