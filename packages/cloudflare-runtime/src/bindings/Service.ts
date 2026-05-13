import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (name: string, service: string) =>
  makeRemoteBinding({ name, type: "service", service }, (service) => ({
    name,
    service,
  }));
