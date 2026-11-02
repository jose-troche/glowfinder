// Eligible candidates: measured variants within a mutational distance of the
// strategy's current reference point, not yet tried by that strategy.

import { variantCodes, type VariantTable } from "../data/loader.ts";

const MAX_CODES = 238 * 20;

/**
 * Number of positions at which each variant's sequence differs from variant `from`'s.
 *
 * d = |positions(a) ∪ positions(b)| - |identical substitutions|
 *   = depth(a) + depth(b) - sharedPositions - sharedCodes
 */
export function distancesFrom(table: VariantTable, from: number, width = 20): Uint8Array {
  const posMark = new Uint8Array(MAX_CODES / width + 1);
  const codeMark = new Uint8Array(MAX_CODES);
  const own = variantCodes(table, from);
  for (const c of own) {
    posMark[Math.floor(c / width)] = 1;
    codeMark[c] = 1;
  }
  const out = new Uint8Array(table.count);
  const { offsets, codes, depth } = table;
  for (let i = 0; i < table.count; i++) {
    let shared = 0;
    for (let k = offsets[i]!; k < offsets[i + 1]!; k++) {
      const c = codes[k]!;
      shared += posMark[Math.floor(c / width)]! + codeMark[c]!;
    }
    out[i] = Math.min(255, depth[i]! + own.length - shared);
  }
  return out;
}

export interface Neighborhood {
  candidates: number[];
  /** radius actually used; wider than requested when the measured set is sparse */
  radius: number;
}

/**
 * Untried variants within `radius` of `from`. The measured set is sparse away from
 * wild type, so the radius widens until at least `minCount` candidates exist.
 */
export function eligibleCandidates(
  table: VariantTable,
  from: number,
  tried: Uint8Array,
  radius: number,
  minCount: number,
): Neighborhood {
  const dist = distancesFrom(table, from);
  let r = radius;
  for (;;) {
    const candidates: number[] = [];
    for (let i = 0; i < table.count; i++) if (!tried[i] && dist[i]! <= r) candidates.push(i);
    if (candidates.length >= minCount || r >= 255) return { candidates, radius: r };
    r++;
  }
}
