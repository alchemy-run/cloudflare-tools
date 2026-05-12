import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (name: string, namespaceId: string) =>
  makeRemoteBinding({ name, type: "kv_namespace", namespaceId, raw: true }, (service) => ({
    name,
    kvNamespace: service,
  }));
