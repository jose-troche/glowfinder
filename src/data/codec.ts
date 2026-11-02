// Mutation integer encoding, shared with pipeline/glowfinder_pipeline/encode.py.
//
//   code = (position - 1) * 20 + aaOrder.indexOf(aa)     position is 1-based
//
// The amino-acid order comes from variants.idx.json, never a literal here.
// test/unit/codec.test.ts replays the pipeline's testVectors to keep both sides honest.

export interface CodecSpec {
  aaOrder: string;
  sequenceLength: number;
}

export interface Mutation {
  position: number;
  aa: string;
}

export function encodeMutation(position: number, aa: string, spec: CodecSpec): number {
  const aaIndex = spec.aaOrder.indexOf(aa);
  if (!Number.isInteger(position) || position < 1 || position > spec.sequenceLength) {
    throw new RangeError(`position ${position} out of range`);
  }
  if (aa.length !== 1 || aaIndex < 0) throw new RangeError(`unknown amino acid ${aa}`);
  return (position - 1) * spec.aaOrder.length + aaIndex;
}

export function decodeMutation(code: number, spec: CodecSpec): Mutation {
  const width = spec.aaOrder.length;
  if (!Number.isInteger(code) || code < 0 || code >= spec.sequenceLength * width) {
    throw new RangeError(`code ${code} out of range`);
  }
  return { position: Math.floor(code / width) + 1, aa: spec.aaOrder[code % width]! };
}

/** "K3R" style label, using the wild-type residue at that position. */
export function formatMutation(code: number, wildType: string, spec: CodecSpec): string {
  const { position, aa } = decodeMutation(code, spec);
  return `${wildType[position - 1]}${position}${aa}`;
}

export function formatVariant(codes: ArrayLike<number>, wildType: string, spec: CodecSpec): string {
  if (codes.length === 0) return "wild type";
  return Array.from(codes, (c) => formatMutation(c, wildType, spec)).join(":");
}

/** Lookup key for a set of mutations: sorted codes joined by commas ("" for wild type). */
export function variantKey(codes: ArrayLike<number>): string {
  return Array.from(codes)
    .sort((a, b) => a - b)
    .join(",");
}
