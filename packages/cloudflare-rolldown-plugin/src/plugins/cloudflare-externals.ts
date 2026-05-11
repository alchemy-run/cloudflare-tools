import { createPlugin } from "../factory.js";

const CLOUDFLARE_BUILTIN_MODULES = [
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
          if (!CLOUDFLARE_BUILTIN_MODULES.includes(id)) {
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
            builtins: CLOUDFLARE_BUILTIN_MODULES,
          },
          optimizeDeps: {
            exclude: CLOUDFLARE_BUILTIN_MODULES,
          },
        };
      },
    },
  };
});
