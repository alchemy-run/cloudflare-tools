// import { cloudflare } from "@cloudflare/vite-plugin";
import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { defineConfig } from "vite";

let serverBundle: vite.OutputChunk | undefined;
let clientDir: string | undefined;

const config = defineConfig({
  plugins: [
    cloudflare({
      compatibilityDate: undefined,
      compatibilityFlags: undefined,
    }),
    {
      name: "output:ssr",
      applyToEnvironment(environment) {
        return environment.name === "ssr";
      },
      generateBundle(_outputOptions, bundle) {
        console.log("serverBundle", bundle);
        serverBundle = bundle;
      },
    },
    {
      name: "output:client",
      applyToEnvironment(environment) {
        return environment.name === "client";
      },
      generateBundle(outputOptions) {
        console.log("clientDir", outputOptions.dir);
        clientDir = outputOptions.dir;
      },
    },
  ],
});

export default config;
