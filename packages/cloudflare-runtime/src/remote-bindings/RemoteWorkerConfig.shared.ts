import type * as workers from "@distilled.cloud/cloudflare/workers";

export interface RemoteWorkerConfig {
  readonly name: string;
  readonly bindings: Array<RemoteBinding>;
}

export interface RemoteWorkerResult {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * A worker binding entry for the edge-preview upload metadata: one of the
 * SDK's script-upload binding variants, plus the edge-preview-only `raw`
 * flag some kinds contribute.
 */
export type RemoteBinding = NonNullable<
  workers.PutScriptMetadata["bindings"]
>[number] & { readonly raw?: boolean };
