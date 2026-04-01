import type { Plugin } from "rolldown";

const CLOUDFLARE_BUILTIN_MODULES = [
  "cloudflare:email",
  "cloudflare:node",
  "cloudflare:sockets",
  "cloudflare:workers",
  "cloudflare:workflows",
];

export const cloudflareExternalsPlugin: Plugin = {
  name: "rolldown-plugin-cloudflare:cloudflare-externals",
  resolveId: {
    filter: { id: /^cloudflare:/ },
    handler(id) {
      if (!CLOUDFLARE_BUILTIN_MODULES.includes(id)) {
        return;
      }

      return {
        id,
        external: true,
      };
    },
  },
};
