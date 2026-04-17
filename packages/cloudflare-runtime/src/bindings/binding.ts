import * as Schema from "effect/Schema";

export const Binding = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("ai"),
  }),
  Schema.Struct({
    dataset: Schema.String,
    name: Schema.String,
    type: Schema.Literal("analytics_engine"),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("assets"),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("browser"),
  }),
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.Literal("d1"),
  }),
  Schema.Struct({
    name: Schema.String,
    part: Schema.String,
    type: Schema.Literal("data_blob"),
  }),
  Schema.Struct({
    name: Schema.String,
    namespace: Schema.String,
    type: Schema.Literal("dispatch_namespace"),
    outbound: Schema.optional(
      Schema.Struct({
        params: Schema.optional(Schema.Array(Schema.String)),
        worker: Schema.optional(
          Schema.Struct({
            environment: Schema.optional(Schema.String),
            service: Schema.optional(Schema.String),
          }),
        ),
      }),
    ),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("durable_object_namespace"),
    className: Schema.optional(Schema.String),
    environment: Schema.optional(Schema.String),
    namespaceId: Schema.optional(Schema.String),
    scriptName: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.Literal("hyperdrive"),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("inherit"),
    oldName: Schema.optional(Schema.String),
    versionId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("images"),
  }),
  Schema.Struct({
    json: Schema.String,
    name: Schema.String,
    type: Schema.Literal("json"),
  }),
  Schema.Struct({
    name: Schema.String,
    namespaceId: Schema.String,
    type: Schema.Literal("kv_namespace"),
  }),
  Schema.Struct({
    certificateId: Schema.String,
    name: Schema.String,
    type: Schema.Literal("mtls_certificate"),
  }),
  Schema.Struct({
    name: Schema.String,
    text: Schema.String,
    type: Schema.Literal("plain_text"),
  }),
  Schema.Struct({
    name: Schema.String,
    pipeline: Schema.String,
    type: Schema.Literal("pipelines"),
  }),
  Schema.Struct({
    name: Schema.String,
    queueName: Schema.String,
    type: Schema.Literal("queue"),
  }),
  Schema.Struct({
    bucketName: Schema.String,
    name: Schema.String,
    type: Schema.Literal("r2_bucket"),
    jurisdiction: Schema.optional(Schema.Literals(["eu", "fedramp"])),
  }),
  Schema.Struct({
    name: Schema.String,
    text: Schema.String,
    type: Schema.Literal("secret_text"),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("send_email"),
    allowedDestinationAddresses: Schema.optional(Schema.Array(Schema.String)),
    allowedSenderAddresses: Schema.optional(Schema.Array(Schema.String)),
    destinationAddress: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    name: Schema.String,
    service: Schema.String,
    type: Schema.Literal("service"),
    environment: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    name: Schema.String,
    part: Schema.String,
    type: Schema.Literal("text_blob"),
  }),
  Schema.Struct({
    indexName: Schema.String,
    name: Schema.String,
    type: Schema.Literal("vectorize"),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("version_metadata"),
  }),
  Schema.Struct({
    name: Schema.String,
    secretName: Schema.String,
    storeId: Schema.String,
    type: Schema.Literal("secrets_store_secret"),
  }),
  Schema.Struct({
    algorithm: Schema.Unknown,
    format: Schema.Literals(["raw", "pkcs8", "spki", "jwk"]),
    name: Schema.String,
    type: Schema.Literal("secret_key"),
    usages: Schema.Array(
      Schema.Literals([
        "encrypt",
        "decrypt",
        "sign",
        "verify",
        "deriveKey",
        "deriveBits",
        "wrapKey",
        "unwrapKey",
      ]),
    ),
    keyBase64: Schema.optional(Schema.String),
    keyJwk: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("workflow"),
    workflowName: Schema.String,
    className: Schema.optional(Schema.String),
    scriptName: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    name: Schema.String,
    part: Schema.String,
    type: Schema.Literal("wasm_module"),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("worker_loader"),
  }),
]);
export type Binding = typeof Binding.Type;
