import type { Plugin } from "rolldown";

export const cloudflareExternalsPlugin = (): Plugin => ({
  name: "distilled-cloudflare-externals",
  resolveId: {
    filter: { id: /^cloudflare:/ },
    handler(id) {
      return {
        id,
        external: true,
      };
    },
  },
});
