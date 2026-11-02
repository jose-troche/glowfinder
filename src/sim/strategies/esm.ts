import type { ModelId } from "../../data/loader.ts";
import { modelScores } from "../scores.ts";
import type { Strategy, StrategyContext } from "../types.ts";

/** Top-n candidates by additive model score; ties broken by variant index. Deterministic. */
export function topByModel(model: ModelId, { dataset, candidates, n }: StrategyContext): number[] {
  const scores = modelScores(dataset, model);
  return candidates
    .slice()
    .sort((a, b) => scores[b]! - scores[a]! || a - b)
    .slice(0, n);
}

/**
 * Protein language model, zero-shot. Has read tens of millions of sequences,
 * never this experiment -- but very few relatives of GFP (see pipeline/bakeoff-report.md).
 */
export const esmStrategy: Strategy = {
  id: "esm",
  label: "ESM-2",
  knows: "Protein language model: 65M UniRef sequences, never this experiment",
  propose: (ctx) => ({ picks: topByModel("esm", ctx) }),
};
