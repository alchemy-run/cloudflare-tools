import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HoistedLayer } from "../HoistedLayer.ts";

export const Counter = HoistedLayer.service("Counter", {
  methods: {
    double: {
      payload: Schema.Number,
      success: Schema.Number,
    },
  },
  streams: {
    countdown: {
      payload: Schema.Number,
      item: Schema.Number,
    },
  },
});

export const CounterLive = Counter.implement({
  double: (value: number) => Effect.succeed(value * 2),
  countdown: (value: number) =>
    Stream.fromIterable(Array.from({ length: value }, (_, index) => value - index)),
});
