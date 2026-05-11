import { createPlugin } from "../factory.js";

const CLOUDFLARE_BUILT_IN_MODULES = [
  "cloudflare:email",
  "cloudflare:node",
  "cloudflare:sockets",
  "cloudflare:workers",
  "cloudflare:workflows",
];

export const cloudflareExternalsPlugin = createPlugin("cloudflare-externals", () => {
  return {
    rolldown: {
      resolveId: {
        filter: { id: /^cloudflare:/ },
        handler(id) {
          if (!CLOUDFLARE_BUILT_IN_MODULES.includes(id)) {
            return;
          }

          return {
            id,
            external: true,
          };
        },
      },
    },
    vite: {
      configEnvironment(name) {
        if (name === "client") return;
        return {
          resolve: {
            builtins: CLOUDFLARE_BUILT_IN_MODULES,
          },
          optimizeDeps: {
            exclude: CLOUDFLARE_BUILT_IN_MODULES,
          },
        };
      },
    },
  };
});
