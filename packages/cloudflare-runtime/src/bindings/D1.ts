import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, id: string) =>
  makeRemoteBinding({ name: binding, type: "d1", id, raw: true }, (service) => ({
    name: binding,
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
