import * as Schema from "effect/Schema";

export const RateLimitProps = Schema.Struct({
  name: Schema.String,
  namespaceId: Schema.Number,
  simple: Schema.Struct({
    limit: Schema.Number.check(Schema.isGreaterThan(0)),
    period: Schema.Literals([10, 60]),
  }),
});
export type RateLimitProps = typeof RateLimitProps.Type;
