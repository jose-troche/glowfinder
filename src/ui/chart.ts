// Live chart: best brightness found so far, per strategy, per round. uPlot redraws
// cheaply every round, which is all this needs.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { RoundResult, Strategy, StrategyId } from "../sim/types.ts";
import { STRATEGY_COLOR } from "./palette.ts";

export interface RaceChart {
  reset(strategies: readonly Strategy[], rounds: number): void;
  push(result: RoundResult): void;
  destroy(): void;
}

export function createRaceChart(container: HTMLElement, wildType: number): RaceChart {
  let plot: uPlot | undefined;
  let ids: StrategyId[] = [];
  let data: (number | null)[][] = [];
  const observer = new ResizeObserver(() => plot?.setSize(size()));

  function size() {
    const width = Math.max(260, container.clientWidth);
    return { width, height: Math.round(Math.min(360, Math.max(220, width * 0.5))) };
  }

  function range(): [number, number] {
    const values = data.slice(1).flat().filter((v): v is number => v !== null);
    const lo = Math.min(wildType, ...values);
    const hi = Math.max(wildType, ...values);
    const pad = Math.max(0.02, (hi - lo) * 0.15);
    return [lo - pad, hi + pad];
  }

  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue("--ink-muted").trim() || "#9aa3ad";
  const grid = css.getPropertyValue("--grid").trim() || "rgba(255,255,255,0.08)";
  const axis = { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } };

  return {
    reset(strategies, rounds) {
      plot?.destroy();
      ids = strategies.map((s) => s.id);
      const xs = Array.from({ length: rounds + 1 }, (_, i) => i);
      // round 0 is the wild type every strategy starts from
      data = [xs, xs.map(() => wildType), ...ids.map(() => xs.map((x) => (x === 0 ? wildType : null)))];
      plot = new uPlot(
        {
          ...size(),
          class: "race-chart",
          legend: { show: false },
          cursor: { points: { size: 7 } },
          scales: { x: { time: false, range: [0, rounds] }, y: { range: () => range() } },
          axes: [
            { ...axis, label: "round", values: (_u, ticks) => ticks.map((t) => (Number.isInteger(t) ? String(t) : "")) },
            { ...axis, label: "best log₁₀ brightness", size: 56, values: (_u, ticks) => ticks.map((t) => t.toFixed(2)) },
          ],
          series: [
            {},
            { label: "wild type", stroke: ink, dash: [4, 4], width: 1, points: { show: false } },
            ...strategies.map((s) => ({
              label: s.label,
              stroke: STRATEGY_COLOR[s.id],
              width: 2.5,
              points: { show: true, size: 6, fill: STRATEGY_COLOR[s.id] },
              spanGaps: false,
            })),
          ],
        },
        data as uPlot.AlignedData,
        container,
      );
      observer.observe(container);
    },
    push(result) {
      if (!plot) return;
      ids.forEach((id, k) => {
        const s = result.perStrategy[id];
        if (s) data[k + 2]![result.round] = s.bestSoFar;
      });
      plot.setData(data as uPlot.AlignedData);
    },
    destroy() {
      observer.disconnect();
      plot?.destroy();
    },
  };
}
