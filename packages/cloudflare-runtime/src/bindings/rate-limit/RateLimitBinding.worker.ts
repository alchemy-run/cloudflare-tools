// Emulated Ratelimit Binding
import type { RateLimitProps } from "./RateLimitProps.shared.ts";

// options for Ratelimit
//   (should be kept in sync with https://bitbucket.cfdata.org/projects/EW/repos/edgeworker/browse/src/edgeworker/internal-api/ratelimit.capnp)
const RATE_LIMIT_OPTION_KEYS = ["key", "limit", "period"];
const RATE_LIMIT_PERIOD_VALUES = [10, 60];

// create a new Ratelimit
export default function makeBinding(env: { PROPS: RateLimitProps }) {
  return new RateLimitBinding(env.PROPS);
}

class RateLimitBinding implements RateLimit {
  buckets: Map<string, number>;
  epoch: number;

  constructor(readonly config: RateLimitProps) {
    this.buckets = new Map<string, number>();
    this.epoch = 0;
  }

  // method that counts and checks against the limit in in-memory buckets
  async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
    // validate options input
    validate(typeof options === "object" && options !== null, "invalid rate limit options");
    const invalidProps = Object.keys(options ?? {}).filter(
      (key) => !RATE_LIMIT_OPTION_KEYS.includes(key),
    );
    validate(invalidProps.length == 0, `bad rate limit options: [${invalidProps.join(",")}]`);
    const {
      key = "",
      limit = this.config.simple.limit,
      period = this.config.simple.period,
    } = options as RateLimitOptions & Partial<RateLimitProps["simple"]>;
    validate(typeof key === "string", `invalid key: ${key}`);
    validate(typeof limit === "number", `limit must be a number: ${limit}`);
    validate(typeof period === "number", `period must be a number: ${period}`);
    validate(RATE_LIMIT_PERIOD_VALUES.includes(period), `unsupported period: ${period}`);

    const epoch = Math.floor(Date.now() / (period * 1000));
    if (epoch != this.epoch) {
      // clear counters
      this.epoch = epoch;
      this.buckets.clear();
    }
    const val = this.buckets.get(key) || 0;
    if (val >= limit) {
      return {
        success: false,
      };
    }
    this.buckets.set(key, val + 1);
    return {
      success: true,
    };
  }
}

function validate(test: boolean, message: string): asserts test {
  if (!test) {
    throw new Error(message);
  }
}
