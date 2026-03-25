import type { Plugin } from "rolldown";
import { createUnplugin } from "unplugin";

const cloudflareExternals = createUnplugin(() => ({
  name: "distilled-cloudflare-externals",
  resolveId: {
    filter: {
      id: /^cloudflare:/,
    },
    handler(id) {
      return {
        id,
        external: true,
      };
    },
  },
}));

export const cloudflareExternalsPlugin = (): Plugin => cloudflareExternals.rolldown() as Plugin;
