import * as Schema from "effect/Schema";

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("RuntimeError", {
  message: Schema.String,
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.DefectWithStack),
}) {}
