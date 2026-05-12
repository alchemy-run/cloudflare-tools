import { defineConfig } from "vite";

const cloudflare = await import("@cloudflare/vite-plugin").then((m) => m.cloudflare);
const distilled = await import("@distilled.cloud/cloudflare-vite-plugin").then((m) => m.default);

const config = defineConfig({
  plugins: [
    // distilled({
    //   main: "./src/server.ts",
    //   compatibilityDate: undefined,
    //   compatibilityFlags: undefined,
    // }),
    cloudflare({
      config: {
        main: "./src/server.ts",
        compatibility_date: undefined,
        compatibility_flags: undefined,
      },
      viteEnvironment: {
        name: "ssr",
      },
    }),
    // {
    //   name: "distilled-cloudflare:info",
    //   configResolved(config) {
    //     console.log(this.meta);
    //     fs.writeFileSync("config-distilled.json", JSON.stringify(config, null, 2));
    //   },
    //   async buildApp(app) {
    //     console.log(app.environments);
    //   },
    // },
  ],
});

export default config;
