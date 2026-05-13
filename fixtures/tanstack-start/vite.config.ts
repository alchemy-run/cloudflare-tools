import { devtools } from "@tanstack/devtools-vite";
import { defineConfig } from "vite";

import { layerRuntime } from "@distilled.cloud/cloudflare-runtime";
import distilled from "@distilled.cloud/cloudflare-vite-plugin";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";

const scope = Scope.makeUnsafe();

const context = await layerRuntime({
  server: {
    port: 0,
    host: "localhost",
  },
  api: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  },
}).pipe(
  Layer.provide(Layer.mergeAll(Credentials.fromEnv(), NodeServices.layer, FetchHttpClient.layer)),
  Layer.buildWithScope(scope),
  Effect.runPromise,
);

const config = defineConfig({
  plugins: [
    distilled({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: ["nodejs_compat"],
      context,
    }),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
