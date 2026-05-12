import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (name: string, id: string) =>
  makeRemoteBinding({ name, type: "d1", id, raw: true }, (service) => ({
    name,
    wrapped: {
      moduleName: "cloudflare-internal:d1-api",
      innerBindings: [
        {
          name: "fetcher",
          service,
        },
      ],
    },
  }));
