# cloudflare-tools

Monorepo for Cloudflare developer tooling powered by Rolldown, Effect, and Vite. Packages are published under [`@distilled.cloud`](https://www.npmjs.com/org/distilled.cloud) on npm.

> Note: This repository does not contain our Effect-native Cloudflare API client, which is published as [`@distilled.cloud/cloudflare`](https://www.npmjs.com/package/@distilled.cloud/cloudflare) on npm and located in our [`distilled`](https://github.com/alchemy-run/distilled/tree/main/packages/cloudflare) monorepo.

## Packages

| Package                                                                              | Description                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [`@distilled.cloud/cloudflare-rolldown-plugin`](packages/cloudflare-rolldown-plugin) | Rolldown plugin for Cloudflare Workers.             |
| [`@distilled.cloud/cloudflare-runtime`](packages/cloudflare-runtime)                 | Effect-native local runtime for Cloudflare Workers. |
| [`@distilled.cloud/cloudflare-vite-plugin`](packages/cloudflare-vite-plugin)         | Vite plugin for Cloudflare Workers.                 |

## Development

```bash
bun install
bun run format
bun run lint
bun run typecheck
bun run build
bun run test
```

Workspace packages live under [`packages/`](packages/).

## License

MIT
