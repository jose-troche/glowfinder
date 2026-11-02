// Per-variant additive scores, computed once per dataset and cached.
// Model score = Σ log P(mutant) - log P(wild type), from a 238 x 20 matrix.
// It ignores epistasis by construction.

import type { Dataset, ModelId } from "../data/loader.ts";
import blosum62 from "./blosum62.json" with { type: "json" };

const cache = new WeakMap<Dataset, Map<string, Float32Array>>();

function memo(dataset: Dataset, key: string, compute: () => Float32Array): Float32Array {
  let byKey = cache.get(dataset);
  if (!byKey) cache.set(dataset, (byKey = new Map()));
  let v = byKey.get(key);
  if (!v) byKey.set(key, (v = compute()));
  return v;
}

/** log-ratio table: ratio[(pos-1)*20 + aa] = logp[pos][aa] - logp[pos][wt] */
export function logRatios(dataset: Dataset, model: ModelId): Float32Array {
  return memo(dataset, `ratios:${model}`, () => {
    const { aaOrder, sequenceLength } = dataset.index;
    const m = dataset.models[model];
    const out = new Float32Array(m.length);
    for (let p = 0; p < sequenceLength; p++) {
      const wt = aaOrder.indexOf(dataset.reference.sequence[p]!);
      for (let a = 0; a < 20; a++) out[p * 20 + a] = m[p * 20 + a]! - m[p * 20 + wt]!;
    }
    return out;
  });
}

export function modelScores(dataset: Dataset, model: ModelId): Float32Array {
  return memo(dataset, `scores:${model}`, () => {
    const ratios = logRatios(dataset, model);
    return sumOverMutations(dataset, (code) => ratios[code]!);
  });
}

/** BLOSUM62 similarity of each substitution to its wild-type residue, summed per variant. */
export function blosumScores(dataset: Dataset): Float32Array {
  return memo(dataset, "blosum", () => {
    const { aaOrder } = dataset.index;
    const idx = (aa: string) => blosum62.order.indexOf(aa);
    const seq = dataset.reference.sequence;
    return sumOverMutations(dataset, (code) => {
      const pos = Math.floor(code / 20);
      return blosum62.matrix[idx(seq[pos]!)]![idx(aaOrder[code % 20]!)]!;
    });
  });
}

function sumOverMutations(dataset: Dataset, perCode: (code: number) => number): Float32Array {
  const out = new Float32Array(dataset.count);
  for (let i = 0; i < dataset.count; i++) {
    let s = 0;
    for (let k = dataset.offsets[i]!; k < dataset.offsets[i + 1]!; k++) s += perCode(dataset.codes[k]!);
    out[i] = s;
  }
  return out;
}
