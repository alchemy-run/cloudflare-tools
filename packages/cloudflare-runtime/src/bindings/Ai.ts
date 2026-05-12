import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (name: string) =>
  makeRemoteBinding(
    {
      name,
      type: "ai",
      raw: true,
    },
    (service) => ({
      name,
      wrapped: {
        moduleName: "cloudflare-internal:ai-api",
        innerBindings: [
          {
            name: "fetcher",
            service,
          },
        ],
      },
    }),
  );
