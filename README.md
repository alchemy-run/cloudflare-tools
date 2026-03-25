# distilled-cloudflare

Monorepo for **Effect-native Cloudflare** developer tools, published under [`@distilled.cloud`](https://www.npmjs.com/org/distilled.cloud) on npm.

## Packages

| Package | Description |
| --- | --- |
| [`@distilled.cloud/cloudflare-bundler`](packages/cloudflare-bundler) | Effect-native bundler for Cloudflare Workers (Rolldown-backed). |

## Development

Requirements: [Bun](https://bun.sh) (version pinned in root `package.json`).

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
