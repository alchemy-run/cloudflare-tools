import type * as workers from "@distilled.cloud/cloudflare/workers";

export interface SessionOptions {
  readonly name: string;
  readonly bindings: Array<RemoteBinding>;
}

export interface OutboundConfig {
  readonly url: string;
  readonly headers: Record<string, string>;
}

type Metadata = NonNullable<NonNullable<workers.CreateScriptEdgePreviewRequest["metadata"]>>;
export type RemoteBinding = NonNullable<NonNullable<Metadata["bindings"]>>[number];
