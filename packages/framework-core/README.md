# @distilled.cloud/framework-core

Shared core for framework integrations (Vite, Waku, Astro, SvelteKit, Next.js) targeting Cloudflare Workers:

- **`BuildOutput` contract** — `{ clientDirectory, serverModules (entry first, sha256-hashed), externalWorkspaces }`, plus `dist/build.json` persistence helpers (`writeBuildOutput` / `readBuildOutput`).
- **Build-output collector** — the `alchemy:build-output` Vite plugin (`makeBuildOutputCollector`): captures client/server outputs across environments, with `skipEnvironments` (e.g. Astro's `prerender`), deterministic server-entry selection (pins the wrapped `\0distilled:worker-entry:` main), and a post-`buildApp` disk re-read mode (`collect({ fromDisk: true })`) for frameworks that write or prune server modules after the bundler finishes (e.g. Waku).
- **`readServerModulesFromDisk`** — for frameworks whose final server bundle lives on disk (SvelteKit's rolldown pass, Next.js's `.open-next` output).
- **`loadProjectModule`** — load the _project's_ `vite`/framework install instead of ours.
- **`Framework` service contract** — the common effectful `{ build, dev, readBuildOutput }` service each framework package implements.
