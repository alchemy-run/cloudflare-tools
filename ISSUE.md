# Windows worker-entry ids keep backslashes in virtual module specifiers

## Summary

`@distilled.cloud/cloudflare-rolldown-plugin` prefixes worker entry ids with `\0distilled:worker-entry:` without normalizing Windows absolute paths first.

On Windows this produces virtual ids like:

```text
\0distilled:worker-entry:D:\workspace\src\index.ts
```

Downstream module resolution expects normalized slash-separated ids, so generated worker bundles can end up with malformed imports and fail to resolve the user entrypoint.

## Reproduction

1. Run a worker build on Windows with an absolute entry path.
2. Inspect the wrapped rolldown input produced by the options plugin.
3. Observe that the virtual entry id still contains backslashes.

## Expected

The plugin should normalize Windows absolute paths before prefixing them, producing ids like:

```text
\0distilled:worker-entry:D:/workspace/src/index.ts
```

## Proposed fix

Normalize worker entry ids on Windows in `packages/cloudflare-rolldown-plugin/src/plugins/options.ts` before applying `WORKER_ENTRY_PREFIX`.

## Validation

- Added a targeted Vitest regression in `packages/cloudflare-rolldown-plugin/test/options.test.ts`
- Before fix: fails because the wrapped input preserves backslashes
- After fix: passes with normalized slash-separated virtual ids