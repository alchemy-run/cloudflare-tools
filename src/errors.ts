/**
 * Defines the error types for distilled-bundler.
 */

import * as Schema from "effect/Schema";

export const BuildErrorLocation = Schema.Struct({
  file: Schema.String,
  namespace: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  length: Schema.Number,
  lineText: Schema.String,
  suggestion: Schema.String,
});

export const BuildErrorNote = Schema.Struct({
  text: Schema.String,
  location: Schema.NullOr(BuildErrorLocation),
});

export const BuildErrorMessage = Schema.Struct({
  id: Schema.String,
  pluginName: Schema.String,
  text: Schema.String,
  location: Schema.NullOr(BuildErrorLocation),
  notes: Schema.Array(BuildErrorNote),

  /**
   * Optional user-specified data that is passed through unmodified. You can
   * use this to stash the original error, for example.
   */
  detail: Schema.Any,
});

export class BuildError extends Schema.TaggedErrorClass<BuildError>()("BuildError", {
  message: Schema.String,
  errors: Schema.Array(BuildErrorMessage),
  warnings: Schema.Array(BuildErrorMessage),
}) {}

export class SystemError extends Schema.TaggedErrorClass<SystemError>()("SystemError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  reason: Schema.Literals(["MissingMetafile", "MissingEntrypoints", "MultipleEntrypoints"]),
  message: Schema.String,
}) {}

export type BundleError = BuildError | SystemError | ValidationError;
