# @distilled.cloud/cloudflare-bundler

You're in the repository for `@distilled.cloud/cloudflare-bundler`, an Effect-native bundler for Cloudflare Workers. This is a greenfield project, but our goal is to:

- extract Workers-specific bundling logic from `wrangler` and `@cloudflare/vite-plugin` in a way that's as bundler-agnostic as possible
- 1:1 bundling support, i.e. if your code works in either Wrangler or the Cloudflare Vite plugin, it should work here
- support for as many major bundlers as possible (e.g. `esbuild`, `rspack`, `rolldown`)

## How do we get there?

1. We have the `workers-sdk` added as a submodule. We need to take a hard look at `wrangler` and `@cloudflare/vite-plugin` to identify all Workers-specific bundling logic, and build a catalog of it. This includes:
   - build settings
   - source maps and remapping
   - esbuild plugins (for `wrangler` especially)
   - handling of additional modules (e.g. WASM, text, SQL)
   - any injected code (`wrangler` includes "middleware" for specific tasks like ensuring the request body is drained; need to look into what `@cloudflare/vite-plugin` does for this)
2. Porting this functionality to be bundler-agnostic. The way we want to do this is by using [`unplugin`](https://github.com/unjs/unplugin), a package created by the `unjs` team that extends the Rollup plugin API to serve as the standard plugin interface, and provides a compatibility layer based on the build tools employed.
3. Providing Effect-native interfaces for each bundler, starting with `esbuild` and `rolldown`.
4. Building a test suite to ensure 1:1 support. The way we want to do this is by adapting all fixtures and other tests from the `workers-sdk` repository, and building a harness that allows us to run them both with `wrangler`/`@cloudflare/vite-plugin` and with our new bundler. Different bundlers will produce different outputs, so the bar for success is whether the outputs can run in Miniflare with assertions (i.e. making `fetch` calls against the Worker and checking the response). We're open to other assertion strategies as well, but runtime compatibility is the gold standard.
5. We also want to compare performance of different bundlers, so our test suite should include benchmarks for that as well.
