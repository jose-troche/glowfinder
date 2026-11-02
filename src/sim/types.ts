import type { Dataset } from "../data/loader.ts";
import type { Rng } from "./rng.ts";

export const STRATEGY_IDS = ["random", "conservative", "esm", "profile", "llm"] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export interface TriedVariant {
  variant: number;
  codes: number[];
  brightness: number;
  round: number;
}

export interface StrategyContext {
  dataset: Dataset;
  rng: Rng;
  round: number;
  /** variant index of the strategy's current reference point */
  current: number;
  /** eligible variant indices (untried, within the neighbourhood) */
  candidates: number[];
  /** how many to propose */
  n: number;
  /** this strategy's own tried variants with revealed brightness */
  history: readonly TriedVariant[];
}

export interface Proposal {
  /** variant indices, each drawn from ctx.candidates */
  picks: number[];
  reasoning?: string;
  /** true when the strategy could not answer and random picks were substituted */
  fallback?: boolean;
  fallbackReason?: string;
}

export interface Strategy {
  id: StrategyId;
  label: string;
  /** what the strategy knows, for the UI */
  knows: string;
  propose(ctx: StrategyContext): Proposal | Promise<Proposal>;
}

export interface SimConfig {
  rounds: number;
  proposalsPerRound: number;
  /** max mutational distance from the current reference point */
  radius: number;
}

export const DEFAULT_CONFIG: SimConfig = { rounds: 10, proposalsPerRound: 5, radius: 3 };

export interface ScoredProposal {
  variant: number;
  codes: number[];
  brightness: number;
  isDark: boolean;
}

export interface StrategyRound {
  proposals: ScoredProposal[];
  bestSoFar: number;
  bestVariant: number;
  /** reference point after selection */
  current: number;
  radiusUsed: number;
  candidateCount: number;
  hits: number;
  dark: number;
  reasoning?: string;
  fallback?: boolean;
  fallbackReason?: string;
}

export interface RoundResult {
  round: number;
  perStrategy: Partial<Record<StrategyId, StrategyRound>>;
}
