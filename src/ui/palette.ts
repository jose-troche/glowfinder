import type { StrategyId } from "../sim/types.ts";

/** One colour per strategy, used by the chart, the scoreboard and the structure view. */
export const STRATEGY_COLOR: Record<StrategyId, string> = {
  random: "#9aa3ad",
  conservative: "#e0a43a",
  esm: "#5aa9ff",
  profile: "#3ee07f",
  llm: "#c58bff",
};

/** Structure highlights: every variant touching a position glowed / some did / none did. */
export const OUTCOME_COLOR = { bright: "#3ee07f", mixed: "#e0a43a", dark: "#ff5d6c" } as const;
