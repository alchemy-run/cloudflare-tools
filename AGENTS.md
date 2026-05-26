This is `cloudflare-tools`, a monorepo with tools for developing Cloudflare Workers.

## Overview

- Package manager: `bun`
- Testing framework: `vitest` (+ `@effect/vitest` in packages that use Effect)
- Linter: `oxlint`
- Formatter: `oxfmt`

Code must pass linting, formatting, and typechecking. Use `bun run check` to run all checks.

## Packages

### Published Packages

- `packages/cloudflare-rolldown-plugin`: Rolldown plugin for Cloudflare Workers.
- `packages/cloudflare-runtime`: Effect-native local runtime for Cloudflare Workers, powered by `workerd`.
- `packages/cloudflare-vite-plugin`: Vite plugin for Cloudflare Workers; composes `cloudflare-rolldown-plugin` and `cloudflare-runtime`.

### Internals

- `workers-sdk/*`: Git submodule containing the `cloudflare/workers-sdk` repository.
- `fixtures/*`: Test fixtures for various Cloudflare Workers scenarios.
- `packages/tools/*`: Internal build and test utilities.
- `packages/vendor/*`: Vendored-in packages from `cloudflare/workers-sdk`. See `packages/vendor/README.md` for more details.

## File Conventions

In the `cloudflare-runtime` package:

- `.worker.ts` files represent internal Cloudflare Workers, checked against `@cloudflare/workers-types`.
- `.shared.ts` files represent code that is shared between Workers and Node.js, such as interfaces and utility functions. These cannot reference Node.js or Workers-specific APIs.
- All other `.ts` files are Node.js code, checked against `@types/node`.

Internal workers are used to implement bindings and services in `workerd`. They are imported using the `worker:` scheme. For example:

```ts
import * as MyWorker from "worker:./MyWorker.worker.ts"; // type: { modules: Record<string, string> }
```

We use `tsdown` to resolve the `worker:` imports into bundled modules that can be passed into `workerd`.

> **Important:** You must re-run `bun run build` after editing any internal worker.

## Adding a new binding type to `cloudflare-runtime`

### 1. Reference the Miniflare implementation

- In Miniflare, bindings are implemented as plugins located at `workers-sdk/packages/miniflare/src/plugins/*`.
- Each plugin defines a set of callbacks. The most important are:
  - `getBindings`: Returns a list of `Worker_Binding`s that will be added to the user's worker in `workerd`.
  - `getServices`: Returns a list of services - typically internal worker scripts - that are used to implement the binding.
  - `getExtensions`: Some simpler bindings are implemented as extensions, which are internal modules that run within the user worker, as opposed to a separate service.
- Some bindings offer local and remote implementations, and some are remote-only. Remote implementations are denoted by the `remoteProxyConnectionString` option.
- The source code for services and extensions is located in `workers-sdk/packages/miniflare/src/workers/*`.
  - Some services extend a Cloudflare internal package, such as `@cloudflare/workers-shared`.
- Look at `workers-sdk/packages/miniflare/test` to see how the binding is tested. The `cloudflare-runtime` implementation must pass all of the same test cases, to the extent possible.

### 2. Implement the remote binding (if applicable)

In `cloudflare-runtime`, create a new file in `src/bindings/*` for the binding. Remote bindings are simple to implement:

```ts
// src/bindings/KvNamespace.ts
import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (name: string, namespaceId: string) =>
  makeRemoteBinding(
    // The binding object, passed to the Cloudflare API:
    { name, type: "kv_namespace", namespaceId, raw: true },
    // The binding implementation, which should match the `getBindings` callback from the Miniflare plugin:
    (service) => ({
      name,
      kvNamespace: service,
    }),
  );
```

### 3. Implement the local binding plugin

If the binding has a local implementation, create a directory at `src/bindings/<binding-name>` instead of a file. This should contain:

- the `<BindingName>.ts` file, which should contain the local binding plugin, a local binding hook, and the remote hook if applicable.
- worker scripts, with the `.worker.ts` extension, which are used to implement the binding.
- `index.ts`, which re-exports all files in the directory except for those ending in `.shared.ts`.

See `src/bindings/assets` and `src/bindings/rate-limit` for examples. The `cloudflare-runtime` package includes a plugin system, similar to Miniflare's but adapted for Effect.

Once a plugin is implemented, you will need to register it in `src/RuntimeServices.ts` in the `layerLocalBindings` function. For example:

```ts
layerLocalBindings = () =>
  Layer.mergeAll(
    Assets.AssetsLive,
    DevRegistryProxy.DevRegistryProxyLive,
    Hyperdrive.HyperdriveLive,
    RateLimit.RateLimitLive,
    <BindingName>.<BindingName>Live, // add new bindings to the list, in alphabetical order
  );
```

### 4. Adapt the relevant services and extensions

Create `.worker.ts` files in `workers-sdk/packages/miniflare/src/workers/<binding-name>` for the services and extensions that need to be adapted.

The upstream worker implementations may be more complex than we need, so you may not want to simply copy and paste. Instead, aim to match the upstream implementation as closely as possible while avoiding unnecessary abstractions and creating as few files as possible.

Some more complex workers are imported from a shared package in the `workers-sdk` monorepo. In this case, use the instructions in `packages/vendor/README.md` to vendor the package into our monorepo. One example of this is the assets binding: this uses `@cloudflare/workers-shared`, which is vendored in as `@distilled.cloud/vendor-workers-shared`.

### 5. Implement tests

Based on the tests in Miniflare, create tests in `cloudflare-runtime/test/bindings/<binding-name>`. Each test case from Miniflare should be adapted here, following the conventions of the existing tests.
