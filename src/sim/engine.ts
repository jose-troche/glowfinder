// The round loop. Pure: no DOM, no network (strategies may await, the engine doesn't care).
//
// Each round, every strategy proposes N untried variants from the neighbourhood of its
// current reference point; real measured brightness is revealed; the brightest proposal
// becomes the new reference point if it beats the current one (greedy selection,
// chosen in the M3 bake-off -- see pipeline/bakeoff-report.md).

import { variantCodes, type Dataset } from "../data/loader.ts";
import { eligibleCandidates } from "./neighborhood.ts";
import { strategyRng, type Rng } from "./rng.ts";
import type {
  Proposal,
  RoundResult,
  ScoredProposal,
  SimConfig,
  Strategy,
  StrategyId,
  StrategyRound,
  TriedVariant,
} from "./types.ts";

interface StrategyState {
  strategy: Strategy;
  rng: Rng;
  current: number;
  currentBrightness: number;
  best: number;
  bestVariant: number;
  tried: Uint8Array;
  history: TriedVariant[];
}

export function isDark(dataset: Dataset, brightness: number): boolean {
  return brightness <= dataset.index.brightness.visibleThreshold;
}

/** Keep only distinct picks that were actually offered; top up at random if short. */
export function validatePicks(
  proposal: Proposal,
  candidates: readonly number[],
  n: number,
  rng: Rng,
): Proposal {
  const offered = new Set(candidates);
  const picks: number[] = [];
  for (const p of Array.isArray(proposal.picks) ? proposal.picks : []) {
    if (offered.has(p) && !picks.includes(p) && picks.length < n) picks.push(p);
  }
  const want = Math.min(n, candidates.length);
  if (picks.length === want) return { ...proposal, picks };

  const rest = candidates.filter((c) => !picks.includes(c));
  const filled = [...picks, ...rng.sample(rest, want - picks.length)];
  const reason = picks.length === 0 ? "no usable picks" : `${picks.length} of ${want} picks usable`;
  return {
    ...proposal,
    picks: filled,
    fallback: true,
    fallbackReason: proposal.fallbackReason ?? `${reason}; filled at random`,
  };
}

async function step(dataset: Dataset, st: StrategyState, config: SimConfig, round: number): Promise<StrategyRound> {
  const n = config.proposalsPerRound;
  const { candidates, radius } = eligibleCandidates(dataset, st.current, st.tried, config.radius, n);

  let proposal: Proposal;
  try {
    proposal = await st.strategy.propose({
      dataset,
      rng: st.rng,
      round,
      current: st.current,
      candidates,
      n,
      history: st.history,
    });
  } catch (err) {
    proposal = { picks: [], fallbackReason: `strategy failed: ${(err as Error).message}` };
  }
  proposal = validatePicks(proposal, candidates, n, st.rng);

  const proposals: ScoredProposal[] = proposal.picks.map((variant) => {
    const brightness = dataset.brightness[variant]!;
    return { variant, codes: Array.from(variantCodes(dataset, variant)), brightness, isDark: isDark(dataset, brightness) };
  });

  let top: ScoredProposal | undefined;
  for (const p of proposals) {
    st.tried[p.variant] = 1;
    st.history.push({ variant: p.variant, codes: p.codes, brightness: p.brightness, round });
    if (!top || p.brightness > top.brightness) top = p;
  }
  if (top && top.brightness > st.currentBrightness) {
    st.current = top.variant;
    st.currentBrightness = top.brightness;
  }
  if (top && top.brightness > st.best) {
    st.best = top.brightness;
    st.bestVariant = top.variant;
  }

  const dark = proposals.filter((p) => p.isDark).length;
  return {
    proposals,
    bestSoFar: st.best,
    bestVariant: st.bestVariant,
    current: st.current,
    radiusUsed: radius,
    candidateCount: candidates.length,
    hits: proposals.length - dark,
    dark,
    ...(proposal.reasoning !== undefined && { reasoning: proposal.reasoning }),
    ...(proposal.fallback && { fallback: true, fallbackReason: proposal.fallbackReason }),
  };
}

export async function* runSimulation(
  dataset: Dataset,
  strategies: readonly Strategy[],
  config: SimConfig,
  seed: string,
): AsyncGenerator<RoundResult> {
  const wt = dataset.wildTypeIndex;
  const wtBrightness = dataset.brightness[wt]!;
  const states: StrategyState[] = strategies.map((strategy) => {
    const tried = new Uint8Array(dataset.count);
    tried[wt] = 1;
    return {
      strategy,
      rng: strategyRng(seed, strategy.id),
      current: wt,
      currentBrightness: wtBrightness,
      best: wtBrightness,
      bestVariant: wt,
      tried,
      history: [],
    };
  });

  for (let round = 1; round <= config.rounds; round++) {
    // Local strategies resolve immediately; only the LLM actually waits on the network.
    const rounds = await Promise.all(states.map((st) => step(dataset, st, config, round)));
    const perStrategy: Partial<Record<StrategyId, StrategyRound>> = {};
    states.forEach((st, k) => (perStrategy[st.strategy.id] = rounds[k]));
    yield { round, perStrategy };
  }
}

export interface StrategyTotals {
  best: number;
  bestVariant: number;
  proposals: number;
  hits: number;
  dark: number;
  hitRate: number;
  fallbackRounds: number;
}

export function totals(results: readonly RoundResult[], id: StrategyId): StrategyTotals | undefined {
  const rounds = results.map((r) => r.perStrategy[id]).filter((r): r is StrategyRound => !!r);
  const last = rounds.at(-1);
  if (!last) return undefined;
  const hits = rounds.reduce((s, r) => s + r.hits, 0);
  const dark = rounds.reduce((s, r) => s + r.dark, 0);
  return {
    best: last.bestSoFar,
    bestVariant: last.bestVariant,
    proposals: hits + dark,
    hits,
    dark,
    hitRate: hits + dark ? hits / (hits + dark) : 0,
    fallbackRounds: rounds.filter((r) => r.fallback).length,
  };
}

export async function collect(gen: AsyncGenerator<RoundResult>): Promise<RoundResult[]> {
  const out: RoundResult[] = [];
  for await (const r of gen) out.push(r);
  return out;
}
