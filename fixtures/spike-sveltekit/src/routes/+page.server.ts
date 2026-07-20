import { uneval } from "devalue";

export const load = ({ platform }) => {
  return {
    secret: platform?.env?.SPIKE_SECRET ?? "no-platform-env",
    hasCtx: typeof platform?.ctx?.waitUntil === "function",
    // exercise `devalue` (conditional-exports dep used by kit itself)
    devalued: uneval({ n: 1 }),
  };
};
