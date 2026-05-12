import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (name: string) =>
  makeRemoteBinding({ name, type: "images", raw: true }, (service) => ({
    name,
    wrapped: {
      moduleName: "cloudflare-internal:images-api",
      innerBindings: [
        {
          name: "fetcher",
          service,
        },
      ],
    },
  }));
