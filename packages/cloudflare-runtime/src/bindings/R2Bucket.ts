import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, bucketName: string, jurisdiction?: string) =>
  makeRemoteBinding(
    { name: binding, type: "r2_bucket", bucketName, jurisdiction, raw: true },
    (service) => ({
      name: binding,
      r2Bucket: service,
    }),
  );
