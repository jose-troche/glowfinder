import { describe, expect, it } from "vitest";
import type { VariantTable } from "../../src/data/loader.ts";
import { distancesFrom, eligibleCandidates } from "../../src/sim/neighborhood.ts";

/** Build a table from variants given as lists of [position, aaIndex]. */
function table(variants: [number, number][][]): VariantTable {
  const offsets = new Uint32Array(variants.length + 1);
  const codes: number[] = [];
  variants.forEach((v, i) => {
    offsets[i] = codes.length;
    codes.push(...v.map(([p, a]) => (p - 1) * 20 + a).sort((x, y) => x - y));
  });
  offsets[variants.length] = codes.length;
  return {
    count: variants.length,
    offsets,
    codes: Uint16Array.from(codes),
    brightness: new Float32Array(variants.length),
    depth: Uint8Array.from(variants.map((v) => v.length)),
    flags: new Uint8Array(variants.length),
  };
}

const t = table([
  [], // 0: wild type
  [[10, 1]], // 1
  [[10, 2]], // 2: same position as 1, different residue
  [[10, 1], [20, 3]], // 3: 1 plus one more
  [[30, 4], [40, 5], [50, 6]], // 4: far away
]);

describe("distance", () => {
  it("counts positions where the sequences differ", () => {
    expect(Array.from(distancesFrom(t, 0))).toEqual([0, 1, 1, 2, 3]);
    expect(Array.from(distancesFrom(t, 1))).toEqual([1, 0, 1, 1, 4]);
    // same position, different residue: one position differs, not two
    expect(distancesFrom(t, 2)[1]).toBe(1);
    expect(distancesFrom(t, 3)[2]).toBe(2);
  });
});

describe("eligible candidates", () => {
  it("excludes tried variants and respects the radius", () => {
    const tried = Uint8Array.from([1, 0, 0, 0, 0]);
    expect(eligibleCandidates(t, 0, tried, 1, 1)).toEqual({ candidates: [1, 2], radius: 1 });
  });

  it("widens the radius when the neighbourhood is too small", () => {
    const tried = Uint8Array.from([1, 1, 1, 0, 0]);
    expect(eligibleCandidates(t, 0, tried, 1, 2)).toEqual({ candidates: [3, 4], radius: 3 });
  });

  it("terminates when everything is tried", () => {
    const tried = Uint8Array.from([1, 1, 1, 1, 1]);
    expect(eligibleCandidates(t, 0, tried, 1, 5).candidates).toEqual([]);
  });
});
