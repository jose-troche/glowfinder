// ArrayBuffer -> flat typed arrays. 51k variants as objects-with-arrays is slow to build
// and heavy; parallel typed arrays with an offset index are allocation-free to scan.

import { variantKey, type CodecSpec } from "./codec.ts";

export const MODEL_IDS = ["esm", "profile"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export interface ModelInfo {
  file: string;
  dtype: "float32";
  shape: [number, number];
  label: string;
  model: string;
  method: string;
  spearman: number;
}

export interface DepthSummary {
  depth: number;
  variants: number;
  visible: number;
  fractionVisible: number;
  brighterThanWildType: number;
}

export interface VariantIndex extends CodecSpec {
  format: { magic: string; version: number; endianness: "little"; headerBytes: number };
  variantCount: number;
  byteLength: number;
  maxMutations: number;
  quantization: { min: number; scale: number };
  flags: { lowConfidence: number };
  brightness: { scale: "log10"; min: number; max: number; wildType: number; visibleThreshold: number };
  depthCounts: Record<string, number>;
  models: Record<ModelId, ModelInfo>;
  summary: {
    genotypesInFile: number;
    withStopCodon: number;
    variantsShipped: number;
    lowConfidenceShipped: number;
    fractionVisible: number;
    byDepth: DepthSummary[];
  };
  testVectors: {
    mutations: { mutation: string; position: number; aa: string; code: number }[];
    variants: { index: number; mutations: string; codes: number[]; brightness: number; lowConfidence: boolean }[];
  };
}

export interface Reference {
  uniprotId: string;
  name: string;
  length: number;
  sequence: string;
  uniprotSequence: string;
  constructDifferences: { position: number; uniprot: string; construct: string }[];
  chromophore: { start: number; end: number; residues: string };
  structure: { file: string; source: string };
  burial: { method: string; hseUp: number[]; buried: boolean[] };
  plddt: number[];
}

export interface VariantTable {
  count: number;
  /** codes of variant i are codes[offsets[i] .. offsets[i + 1]) */
  offsets: Uint32Array;
  codes: Uint16Array;
  brightness: Float32Array;
  depth: Uint8Array;
  flags: Uint8Array;
}

export interface Dataset extends VariantTable {
  index: VariantIndex;
  reference: Reference;
  /** 238 x 20 log-probability matrices, row-major, columns in index.aaOrder */
  models: Record<ModelId, Float32Array>;
  /** sorted-codes key -> variant index */
  lookup: Map<string, number>;
  wildTypeIndex: number;
}

export function parseVariants(buf: ArrayBuffer, index: VariantIndex): VariantTable {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== index.format.magic || view.getUint16(4, true) !== index.format.version) {
    throw new Error("variants.bin: bad magic or version");
  }
  const count = view.getUint32(8, true);
  if (count !== index.variantCount || buf.byteLength !== index.byteLength) {
    throw new Error("variants.bin does not match variants.idx.json");
  }

  const offsets = new Uint32Array(count + 1);
  const brightness = new Float32Array(count);
  const depth = new Uint8Array(count);
  const flags = new Uint8Array(count);
  // Upper bound on total codes: every record is >= 4 bytes plus 2 per code.
  const scratch = new Uint16Array((buf.byteLength - index.format.headerBytes) >> 1);
  const { min, scale } = index.quantization;

  let p = index.format.headerBytes;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const n = view.getUint8(p++);
    offsets[i] = total;
    for (let k = 0; k < n; k++, p += 2) scratch[total++] = view.getUint16(p, true);
    brightness[i] = min + view.getUint16(p, true) * scale;
    flags[i] = view.getUint8(p + 2);
    depth[i] = n;
    p += 3;
  }
  offsets[count] = total;
  if (p !== buf.byteLength) throw new Error(`variants.bin: ${buf.byteLength - p} trailing bytes`);
  return { count, offsets, codes: scratch.slice(0, total), brightness, depth, flags };
}

export function variantCodes(table: VariantTable, i: number): Uint16Array {
  return table.codes.subarray(table.offsets[i]!, table.offsets[i + 1]!);
}

export function buildLookup(table: VariantTable): Map<string, number> {
  const lookup = new Map<string, number>();
  for (let i = 0; i < table.count; i++) lookup.set(variantKey(variantCodes(table, i)), i);
  return lookup;
}

export type FetchLike = (path: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export async function loadDataset(fetchFn: FetchLike = (p) => fetch(p), base = "/artifacts"): Promise<Dataset> {
  const get = async (name: string) => {
    const res = await fetchFn(`${base}/${name}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res;
  };
  const [index, buf, reference] = await Promise.all([
    get("variants.idx.json").then((r) => r.json() as Promise<VariantIndex>),
    get("variants.bin").then((r) => r.arrayBuffer()),
    get("reference.json").then((r) => r.json() as Promise<Reference>),
  ]);
  const matrices = await Promise.all(
    MODEL_IDS.map((id) => get(index.models[id].file).then((r) => r.arrayBuffer())),
  );

  const table = parseVariants(buf, index);
  const models = {} as Record<ModelId, Float32Array>;
  MODEL_IDS.forEach((id, k) => {
    const m = new Float32Array(matrices[k]!);
    const [rows, cols] = index.models[id].shape;
    if (m.length !== rows * cols) throw new Error(`${id} matrix has ${m.length} values`);
    models[id] = m;
  });
  const lookup = buildLookup(table);
  const wildTypeIndex = lookup.get("");
  if (wildTypeIndex === undefined) throw new Error("wild type missing from variants.bin");
  return { ...table, index, reference, models, lookup, wildTypeIndex };
}
