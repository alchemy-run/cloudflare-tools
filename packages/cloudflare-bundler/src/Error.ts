/**
 * Defines the error types for distilled-bundler.
 */

import * as Schema from "effect/Schema";

export const DiagnosticLocation = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
});
export type DiagnosticLocation = typeof DiagnosticLocation.Type;

export const Diagnostic = Schema.Struct({
  message: Schema.String,
  plugin: Schema.optional(Schema.String),
  severity: Schema.Literals(["error", "warning"]),
  location: Schema.optional(DiagnosticLocation),
});
export type Diagnostic = typeof Diagnostic.Type;

export class BuildError extends Schema.TaggedErrorClass<BuildError>()("BuildError", {
  message: Schema.String,
  diagnostics: Schema.Array(Diagnostic),
}) {}

export class SystemError extends Schema.TaggedErrorClass<SystemError>()("SystemError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  reason: Schema.String,
  message: Schema.String,
}) {}

export type BundleError = BuildError | SystemError | ValidationError;
