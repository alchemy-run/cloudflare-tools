import { makeRemoteBinding } from "../remote-bindings/RemoteBindings";

export const binding = (name: string) =>
  makeRemoteBinding({ name, type: "browser" }, (service) => ({
    name,
    service,
  }));
