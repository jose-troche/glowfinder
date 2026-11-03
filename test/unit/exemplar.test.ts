import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { variantKey } from "../../src/data/codec.ts";
import { collect, runSimulation, totals } from "../../src/sim/engine.ts";
import { createExemplarStrategy, exemplarConfigMatches, type ExemplarRun } from "../../src/sim/strategies/llm.ts";
import { DEFAULT_CONFIG } from "../../src/sim/types.ts";
import { ARTIFACTS, realDataset } from "./helpers.ts";

const ds = await realDataset();
const exemplar = JSON.parse(await readFile(ARTIFACTS + "exemplar-llm-run.json", "utf8")) as ExemplarRun;

describe("recorded LLM run", () => {
  it("is a complete run under the default settings", () => {
    expect(exemplar.rounds).toHaveLength(exemplar.config.rounds);
    expect(exemplarConfigMatches(exemplar, DEFAULT_CONFIG)).toBe(true);
    for (const r of exemplar.rounds) {
      expect(r.played).toHaveLength(exemplar.config.proposalsPerRound);
      for (const codes of r.played) expect(ds.lookup.has(variantKey(codes))).toBe(true);
      // the model only ever saw bare code arrays
      for (const c of r.offered) expect(c.every(Number.isInteger)).toBe(true);
    }
  });

  it.each(["exemplar", "any-other-seed"])("replays identically whatever the race seed (%s)", async (seed) => {
    const results = await collect(runSimulation(ds, [createExemplarStrategy(exemplar)], exemplar.config, seed));
    results.forEach((r, i) => {
      const played = r.perStrategy.llm!.proposals.map((p) => p.codes);
      expect(played).toEqual(exemplar.rounds[i]!.played);
      expect(Boolean(r.perStrategy.llm!.fallback)).toBe(Boolean(exemplar.rounds[i]!.fallback));
      expect(r.perStrategy.llm!.reasoning).toBe(exemplar.rounds[i]!.reasoning);
    });
    expect(totals(results, "llm")!.proposals).toBe(50);
  });

  it("does not match settings it wasn't recorded with", () => {
    expect(exemplarConfigMatches(exemplar, { ...DEFAULT_CONFIG, radius: 5 })).toBe(false);
  });
});
