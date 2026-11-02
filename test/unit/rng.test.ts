import { describe, expect, it } from "vitest";
import { createRng, strategyRng } from "../../src/sim/rng.ts";

const draw = (seed: string | number, n = 100) => {
  const r = createRng(seed);
  return Array.from({ length: n }, () => r.next());
};

describe("seeded rng", () => {
  it("is deterministic", () => {
    expect(draw("gfp")).toEqual(draw("gfp"));
    expect(draw(42)).toEqual(draw(42));
  });

  it("differs across seeds", () => {
    expect(draw("gfp")).not.toEqual(draw("gfq"));
  });

  it("stays in [0, 1) and is roughly uniform", () => {
    const xs = draw("uniform", 20000);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
  });

  it("samples distinct items", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const s = createRng(1).sample(items, 20);
    expect(new Set(s).size).toBe(20);
    expect(createRng(1).sample(items, 80)).toHaveLength(50);
  });

  it("weighted sampling never returns zero-weight items and prefers heavy ones", () => {
    const r = createRng(7);
    const counts = [0, 0, 0];
    for (let t = 0; t < 3000; t++) {
      const [pick] = r.weightedSample(["a", "b", "c"], [0, 1, 9], 1);
      counts["abc".indexOf(pick!)]!++;
    }
    expect(counts[0]).toBe(0);
    expect(counts[2]).toBeGreaterThan(counts[1]! * 5);
    expect(new Set(createRng(3).weightedSample([1, 2, 3, 4], [1, 1, 1, 0], 4))).toEqual(new Set([1, 2, 3]));
  });

  it("gives each strategy an independent stream", () => {
    const a = strategyRng("seed", "random").next();
    const b = strategyRng("seed", "conservative").next();
    expect(a).not.toBe(b);
    expect(strategyRng("seed", "random").next()).toBe(a);
  });
});
