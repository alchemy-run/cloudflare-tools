#!/usr/bin/env node

import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Options from "./Options.ts";
import * as Runtime from "./Runtime.ts";
import * as Server from "./Server.ts";
import * as Vite from "./Vite.ts";

const build = Command.make(
  "build",
  {},
  Effect.fn(function* () {
    const vite = yield* Vite.Vite;
    const options = yield* Options.load();
    yield* vite.build(options.vite);
  }),
);

const dev = Command.make(
  "dev",
  {
    port: Flag.integer("port").pipe(Flag.optional),
  },
  Effect.fn(function* ({ port }) {
    const vite = yield* Vite.Vite;
    const options = yield* Options.load();
    const { server } = yield* vite.dev(options.vite, { server: { port: port.valueOrUndefined } });
    yield* Effect.sync(() => server.printUrls());
    yield* Effect.never;
  }),
);

const preview = Command.make(
  "preview",
  {},
  Effect.fn(function* () {
    const server = yield* Server.Server;
    const instance = yield* server.live();
    yield* Effect.log("Previewing on", instance.url.toString());
    yield* Effect.never;
  }),
);

Command.make("e2e").pipe(
  Command.withSubcommands([build, dev, preview]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(Runtime.layer),
  Runtime.runMain,
);
