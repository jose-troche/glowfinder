import type { Strategy } from "../types.ts";

/** The control: uniform over the eligible neighbourhood. Knows nothing. */
export const randomStrategy: Strategy = {
  id: "random",
  label: "Random",
  knows: "Nothing",
  propose: ({ rng, candidates, n }) => ({ picks: rng.sample(candidates, n) }),
};
