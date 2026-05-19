// This package has no Node-facing API surface. The upstream
// `@cloudflare/workflows-shared` only exports Durable Object / Worker
// classes that depend on `cloudflare:workers`, which cannot be typechecked
// under a Node-only tsconfig. Consumers should import the Workers entry
// directly via the `./workers/workflows-shared` subpath.
export {};
