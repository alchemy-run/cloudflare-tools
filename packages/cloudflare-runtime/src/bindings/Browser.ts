import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const binding = (name: string) =>
  makeRemoteBinding({ name, type: "browser" }, (service) => ({
    name,
    service,
  }));
