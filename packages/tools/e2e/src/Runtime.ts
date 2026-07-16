import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Server from "./Server.ts";
import * as Vite from "./Vite.ts";

export const Cwd = Context.Reference("@distilled.cloud/e2e/Cwd", {
  defaultValue: () => process.cwd(),
});

export const layer = Server.layer.pipe(
  Layer.provideMerge(Vite.ViteLive),
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
