import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (name: string, bucketName: string, jurisdiction?: string) =>
  makeRemoteBinding(
    { name, type: "r2_bucket", bucketName, jurisdiction, raw: true },
    (service) => ({
      name,
      r2Bucket: service,
    }),
  );
