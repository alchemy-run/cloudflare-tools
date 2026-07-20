import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Framework from "./Framework.ts";
import * as Server from "./Server.ts";

export { Cwd } from "./Cwd.ts";

export const layer = Server.layer.pipe(
  Layer.provideMerge(Framework.layer),
  Layer.provideMerge(
    ConfigProvider.layer(
      ConfigProvider.fromDotEnv().pipe(Effect.orElseSucceed(() => ConfigProvider.fromEnv())),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

export const runMain = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const scope = Scope.makeUnsafe();
  return NodeRuntime.runMain(effect.pipe(Scope.provide(scope)), {
    teardown: (exit, onExit) => {
      Effect.runPromise(Scope.close(scope, exit)).then(() =>
        onExit(exit._tag === "Success" ? 0 : 1),
      );
    },
  });
};
