/// <reference types="@cloudflare/workers-types/experimental" />

declare abstract class ColoLocalActorNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> {
  get(actorId: string): Fetcher<T>;
}
