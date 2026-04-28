import * as Schema from "effect/Schema";

export class ProxyError extends Schema.TaggedErrorClass<ProxyError>()("ProxyError", {
  message: Schema.String,
  cause: Schema.optional(Schema.DefectWithStack),
}) {}
