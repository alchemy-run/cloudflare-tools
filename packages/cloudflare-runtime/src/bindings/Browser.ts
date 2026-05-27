import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string) =>
  makeRemoteBinding({ name: binding, type: "browser" }, (service) => ({
    name: binding,
    service,
  }));
