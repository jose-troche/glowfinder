import { blosumScores } from "../scores.ts";
import type { Strategy } from "../types.ts";

/** Higher = more willing to stray from chemically similar substitutions. */
export const CONSERVATIVE_TEMPERATURE = 2;

/**
 * Classical, pre-ML intuition: prefer substitutions that swap a residue for a
 * chemically similar one. Samples with weight exp(BLOSUM62 sum / T).
 */
export const conservativeStrategy: Strategy = {
  id: "conservative",
  label: "Conservative",
  knows: "Substitution chemistry only (BLOSUM62)",
  propose: ({ dataset, rng, candidates, n }) => {
    const blosum = blosumScores(dataset);
    const weights = candidates.map((i) => Math.exp(blosum[i]! / CONSERVATIVE_TEMPERATURE));
    return { picks: rng.weightedSample(candidates, weights, n) };
  },
};
