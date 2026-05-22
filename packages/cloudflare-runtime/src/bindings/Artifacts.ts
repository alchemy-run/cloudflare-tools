import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const binding = (name: string, namespace: string) =>
  makeRemoteBinding({ name, type: "artifacts", namespace }, (service) => ({
    name,
    service,
  }));
