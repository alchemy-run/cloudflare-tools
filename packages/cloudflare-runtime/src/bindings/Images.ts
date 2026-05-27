import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string) =>
  makeRemoteBinding({ name: binding, type: "images", raw: true }, (service) => ({
    name: binding,
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
