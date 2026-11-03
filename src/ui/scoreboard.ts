// Scoreboard and one-line verdicts. Every phrase is derived from the run's numbers.

import { totals, type StrategyTotals } from "../sim/engine.ts";
import type { RoundResult, Strategy, StrategyId } from "../sim/types.ts";
import { STRATEGY_COLOR } from "./palette.ts";
import { el } from "./dom.ts";

export interface Standing {
  strategy: Strategy;
  totals: StrategyTotals;
}

export function standings(results: readonly RoundResult[], strategies: readonly Strategy[]): Standing[] {
  return strategies
    .map((strategy) => ({ strategy, totals: totals(results, strategy.id) }))
    .filter((s): s is Standing => s.totals !== undefined)
    .sort((a, b) => b.totals.best - a.totals.best || a.totals.dark - b.totals.dark);
}

/** Linear fold change from a log10 difference. */
export function foldOver(best: number, wildType: number): number {
  return 10 ** (best - wildType);
}

export function verdict(s: Standing, wildType: number, all: readonly Standing[]): string {
  const t = s.totals;
  const fold = foldOver(t.best, wildType);
  const bright =
    t.best <= wildType + 1e-9 ? "never beat wild type" : `brightest find ${fold.toFixed(2)}× wild type`;
  const dark =
    t.dark === 0
      ? `all ${t.proposals} proposals kept glowing`
      : `${t.dark} of ${t.proposals} proposals went dark`;
  const random = all.find((x) => x.strategy.id === "random");
  let vsRandom = "";
  if (random && s.strategy.id !== "random") {
    const diff = random.totals.dark - t.dark;
    vsRandom = diff > 0 ? `, ${diff} fewer than random` : diff < 0 ? `, ${-diff} more than random` : ", same as random";
    if (t.dark === 0 && random.totals.dark === 0) vsRandom = "";
  }
  const fallback = t.fallbackRounds ? ` (${t.fallbackRounds} round${t.fallbackRounds > 1 ? "s" : ""} fell back to random picks)` : "";
  return `${bright}; ${dark}${vsRandom}${fallback}.`;
}

export function renderScoreboard(
  table: HTMLTableSectionElement,
  results: readonly RoundResult[],
  strategies: readonly Strategy[],
  wildType: number,
): void {
  const rows = standings(results, strategies);
  table.replaceChildren(
    ...rows.map((s, rank) => {
      const t = s.totals;
      return el("tr", { "data-strategy": s.strategy.id }, [
        el("td", { class: "rank" }, [String(rank + 1)]),
        el("th", { scope: "row" }, [
          el("span", { class: "swatch", style: `background:${STRATEGY_COLOR[s.strategy.id]}` }),
          s.strategy.label,
        ]),
        el("td", { class: "num", "data-col": "best" }, [t.best.toFixed(3)]),
        el("td", { class: "num", "data-col": "fold" }, [`${foldOver(t.best, wildType).toFixed(2)}×`]),
        el("td", { class: "num", "data-col": "hit" }, [`${Math.round(100 * t.hitRate)}%`]),
        el("td", { class: `num dark-count${t.dark ? " has-dark" : ""}`, "data-col": "dark" }, [String(t.dark)]),
      ]);
    }),
  );
}

export function renderDarkCounters(container: HTMLElement, results: readonly RoundResult[], strategies: readonly Strategy[]) {
  container.replaceChildren(
    ...strategies.map((s) => {
      const dark = totals(results, s.id)?.dark ?? 0;
      return el("div", { class: "dark-counter", "data-strategy": s.id }, [
        el("span", { class: "dark-number", style: `color:${STRATEGY_COLOR[s.id]}` }, [String(dark)]),
        el("span", { class: "dark-label" }, [s.label]),
      ]);
    }),
  );
}

export function idsOf(strategies: readonly Strategy[]): StrategyId[] {
  return strategies.map((s) => s.id);
}
