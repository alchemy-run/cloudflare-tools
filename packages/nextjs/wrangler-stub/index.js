// This is a stub. @distilled.cloud/nextjs is wrangler-free by design: only
// wrangler's package.json (the version field) is ever read, by
// @opennextjs/cloudflare's `ensureNextjsVersionSupported`. No wrangler code
// may run on the build path — fail loudly if anything tries.
throw new Error(
  "wrangler is stubbed out by @distilled.cloud/nextjs: the OpenNext build path must never execute wrangler code.",
);
