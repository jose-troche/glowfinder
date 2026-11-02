import { describe, expect, it } from "vitest";
import { collect, runSimulation, totals, validatePicks } from "../../src/sim/engine.ts";
import { createRng } from "../../src/sim/rng.ts";
import { LOCAL_STRATEGIES, profileStrategy, randomStrategy, esmStrategy } from "../../src/sim/strategies/index.ts";
import { buildRequest, createLiveLlmStrategy } from "../../src/sim/strategies/llm.ts";
import { DEFAULT_CONFIG, type Strategy } from "../../src/sim/types.ts";
import { realDataset } from "./helpers.ts";

const ds = await realDataset();
const run = (strategies: readonly Strategy[], seed: string, config = DEFAULT_CONFIG) =>
  collect(runSimulation(ds, strategies, config, seed));

describe("engine determinism", () => {
  it("the same seed produces an identical run, twice", async () => {
    const a = await run(LOCAL_STRATEGIES, "reproducible");
    const b = await run(LOCAL_STRATEGIES, "reproducible");
    expect(b).toEqual(a);
    expect(a).toHaveLength(DEFAULT_CONFIG.rounds);
  });

  it("a different seed changes the stochastic strategies only", async () => {
    const a = await run(LOCAL_STRATEGIES, "seed-a");
    const b = await run(LOCAL_STRATEGIES, "seed-b");
    expect(b.map((r) => r.perStrategy.random)).not.toEqual(a.map((r) => r.perStrategy.random));
    expect(b.map((r) => r.perStrategy.profile)).toEqual(a.map((r) => r.perStrategy.profile));
  });

  it("removing a strategy does not change another strategy's run", async () => {
    const all = await run(LOCAL_STRATEGIES, "independent");
    const alone = await run([randomStrategy], "independent");
    expect(alone.map((r) => r.perStrategy.random)).toEqual(all.map((r) => r.perStrategy.random));
  });
});

describe("engine rules", async () => {
  const results = await run(LOCAL_STRATEGIES, "rules");

  it("spends exactly the budget and never repeats a variant", () => {
    for (const s of LOCAL_STRATEGIES) {
      const proposals = results.flatMap((r) => r.perStrategy[s.id]!.proposals.map((p) => p.variant));
      expect(proposals).toHaveLength(DEFAULT_CONFIG.rounds * DEFAULT_CONFIG.proposalsPerRound);
      expect(new Set(proposals).size).toBe(proposals.length);
      expect(proposals).not.toContain(ds.wildTypeIndex);
    }
  });

  it("every revealed brightness is the real measurement", () => {
    for (const r of results)
      for (const s of Object.values(r.perStrategy))
        for (const p of s!.proposals) {
          expect(p.brightness).toBe(ds.brightness[p.variant]);
          expect(p.isDark).toBe(p.brightness <= 2.5);
        }
  });

  it("best-so-far never decreases and starts from wild type", () => {
    for (const s of LOCAL_STRATEGIES) {
      const best = results.map((r) => r.perStrategy[s.id]!.bestSoFar);
      expect(best[0]).toBeGreaterThanOrEqual(ds.brightness[ds.wildTypeIndex]!);
      best.slice(1).forEach((b, i) => expect(b).toBeGreaterThanOrEqual(best[i]!));
    }
  });

  it("proposals stay within the neighbourhood radius actually used", () => {
    for (const r of results) {
      const s = r.perStrategy.random!;
      expect(s.radiusUsed).toBeGreaterThanOrEqual(DEFAULT_CONFIG.radius);
      expect(s.candidateCount).toBeGreaterThanOrEqual(DEFAULT_CONFIG.proposalsPerRound);
    }
  });
});

describe("the central claim (regression test)", () => {
  // The project's real regression test: over 20 seeded runs, knowing the protein family
  // beats knowing nothing. If this fails, something regressed.
  it("the evolutionary profile beats random over 20 seeded runs", async () => {
    let profileWins = 0;
    let randomDark = 0;
    let profileDark = 0;
    for (let seed = 0; seed < 20; seed++) {
      const results = await run([randomStrategy, profileStrategy], `regression-${seed}`);
      const r = totals(results, "random")!;
      const p = totals(results, "profile")!;
      randomDark += r.dark;
      profileDark += p.dark;
      if (p.best > r.best) profileWins++;
    }
    expect(profileDark).toBeLessThan(randomDark / 4);
    expect(profileWins).toBeGreaterThanOrEqual(15);
  });

  it("ESM-2 does not beat the evolutionary profile on GFP (the documented finding)", async () => {
    const results = await run([esmStrategy, profileStrategy], "finding");
    const e = totals(results, "esm")!;
    const p = totals(results, "profile")!;
    expect(e.dark).toBeGreaterThan(p.dark);
    expect(e.best).toBeLessThanOrEqual(p.best);
  });
});

describe("pick validation", () => {
  const rng = () => createRng("validate");

  it("passes valid picks through", () => {
    expect(validatePicks({ picks: [3, 1] }, [1, 2, 3], 2, rng())).toEqual({ picks: [3, 1] });
  });

  it("drops picks that were never offered or repeated, and tops up", () => {
    const out = validatePicks({ picks: [9, 1, 1] }, [1, 2, 3], 2, rng());
    expect(out.picks).toHaveLength(2);
    expect(out.picks[0]).toBe(1);
    expect([2, 3]).toContain(out.picks[1]);
    expect(out.fallback).toBe(true);
  });

  it("flags a fully failed strategy as a fallback round", async () => {
    const broken: Strategy = { id: "llm", label: "Broken", knows: "", propose: () => Promise.reject(new Error("boom")) };
    const [first] = await collect(runSimulation(ds, [broken], { ...DEFAULT_CONFIG, rounds: 1 }, "x"));
    const s = first!.perStrategy.llm!;
    expect(s.fallback).toBe(true);
    expect(s.fallbackReason).toMatch(/boom/);
    expect(s.proposals).toHaveLength(DEFAULT_CONFIG.proposalsPerRound);
  });
});

describe("LLM requests never leak ground truth", () => {
  it("candidates are bare code arrays and history holds only tried variants", async () => {
    const requests: ReturnType<typeof buildRequest>[] = [];
    const llm = createLiveLlmStrategy(async (req) => {
      requests.push(req);
      return { picks: [0, 1, 2, 3, 4], reasoning: "test", neuronsEstimated: 0 };
    });
    const results = await run([llm], "leak-check", { ...DEFAULT_CONFIG, rounds: 3 });
    expect(requests).toHaveLength(3);

    const tried = new Set(results.flatMap((r) => r.perStrategy.llm!.proposals.map((p) => p.codes.join(","))));
    for (const req of requests) {
      for (const c of req.candidates) {
        expect(Array.isArray(c)).toBe(true);
        c.forEach((code) => expect(Number.isInteger(code)).toBe(true));
      }
      for (const h of req.history) expect(tried.has(h.variant.join(","))).toBe(true);
      expect(JSON.stringify(req.candidates)).not.toMatch(/bright|score|fitness/i);
    }
    // round 1 has no history; round 3 knows exactly the 10 variants it tried before
    expect(requests[0]!.history).toHaveLength(0);
    expect(requests[2]!.history).toHaveLength(10);
  });
});
