import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, namespaceId: string) =>
  makeRemoteBinding({ name: binding, type: "kv_namespace", namespaceId, raw: true }, (service) => ({
    name: binding,
    kvNamespace: service,
  }));
