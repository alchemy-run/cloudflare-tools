declare abstract class ColoLocalActorNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> {
  get(actorId: string): Fetcher<T>;
}
