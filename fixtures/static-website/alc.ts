import cloudflare from "@distilled.cloud/cloudflare-vite-plugin";
import { createBuilder } from "vite";

const builder = await createBuilder(
  {
    plugins: [
      cloudflare({
        compatibilityDate: undefined,
        compatibilityFlags: undefined,
      }),
    ],
  },
  null,
);

await builder.buildApp();
