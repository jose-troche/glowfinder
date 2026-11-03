// Shareable, seeded URLs: everything needed to reproduce a race lives in the query string.

import { STRATEGY_IDS, DEFAULT_CONFIG, type SimConfig, type StrategyId } from "../sim/types.ts";

export type LlmMode = "recorded" | "live";

export interface RaceSettings {
  seed: string;
  config: SimConfig;
  strategies: StrategyId[];
  llmMode: LlmMode;
}

export const DEFAULT_STRATEGIES: StrategyId[] = ["random", "conservative", "esm", "profile"];

export const LIMITS = {
  rounds: [3, 20],
  proposalsPerRound: [1, 10],
  radius: [1, 8],
} as const satisfies Record<keyof SimConfig, readonly [number, number]>;

function clampInt(raw: string | null, [lo, hi]: readonly [number, number], fallback: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function sanitizeSeed(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().slice(0, 32);
  return /^[\w-]+$/.test(s) ? s : null;
}

export function parseSettings(search: string, fallbackSeed: () => string): RaceSettings {
  const q = new URLSearchParams(search);
  const listed = q.get("s")?.split(",").filter((s): s is StrategyId => (STRATEGY_IDS as readonly string[]).includes(s));
  return {
    seed: sanitizeSeed(q.get("seed")) ?? fallbackSeed(),
    config: {
      rounds: clampInt(q.get("rounds"), LIMITS.rounds, DEFAULT_CONFIG.rounds),
      proposalsPerRound: clampInt(q.get("n"), LIMITS.proposalsPerRound, DEFAULT_CONFIG.proposalsPerRound),
      radius: clampInt(q.get("radius"), LIMITS.radius, DEFAULT_CONFIG.radius),
    },
    strategies: listed?.length ? [...new Set(listed)] : DEFAULT_STRATEGIES,
    llmMode: q.get("llm") === "live" ? "live" : "recorded",
  };
}

export function serializeSettings(s: RaceSettings): string {
  const q = new URLSearchParams({
    seed: s.seed,
    rounds: String(s.config.rounds),
    n: String(s.config.proposalsPerRound),
    radius: String(s.config.radius),
    s: s.strategies.join(","),
  });
  if (s.strategies.includes("llm") && s.llmMode === "live") q.set("llm", "live");
  return `?${q}`;
}
