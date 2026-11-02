// Prompt construction and defensive parsing for the LLM strategy.
// The model sees structure context and its own revealed history -- never brightness
// for a candidate it has not tried.

import reference from "../../data/artifacts/reference.json" with { type: "json" };

export const AA_ORDER = "ACDEFGHIKLMNPQRSTVWY";
export const MAX_REASONING_CHARS = 600;
export const MAX_HISTORY_LINES = 20;
export const MAX_OUTPUT_TOKENS = 400;

export interface MoveInput {
  currentVariant: number[];
  candidates: number[][];
  history: { variant: number[]; brightness: number; round: number }[];
  round: number;
  n: number;
}

const WILD_TYPE = reference.sequence;
const CHROMOPHORE = reference.chromophore;

export function describeMutation(code: number): string {
  const position = Math.floor(code / 20) + 1;
  const mut = AA_ORDER[code % 20];
  const wt = WILD_TYPE[position - 1];
  let where: string;
  if (position >= CHROMOPHORE.start && position <= CHROMOPHORE.end) where = "chromophore";
  else if (Math.abs(position - CHROMOPHORE.start) <= 3 || Math.abs(position - CHROMOPHORE.end) <= 3) where = "next to chromophore";
  else where = reference.burial.buried[position - 1] ? "buried" : "surface";
  return `${wt}${position}${mut} (${where})`;
}

export function describeVariant(codes: number[]): string {
  return codes.length ? codes.map(describeMutation).join(", ") : "wild type";
}

function describeBrightness(b: number): string {
  return `${b.toFixed(2)} ${b > 2.5 ? "glows" : "DARK"}`;
}

export const SYSTEM_PROMPT =
  "You are a protein engineer evolving green fluorescent protein. You reason briefly about " +
  "structure and chemistry, then answer with a single JSON object and nothing else.";

export function buildPrompt(input: MoveInput): string {
  const history = input.history.slice(-MAX_HISTORY_LINES);
  const omitted = input.history.length - history.length;
  return [
    "You are evolving a fluorescent protein. You cannot see any brightness values except for",
    "variants you have already tried.",
    "",
    `Wild-type avGFP, ${reference.length} residues. Chromophore: residues ${CHROMOPHORE.start}-${CHROMOPHORE.end} (${CHROMOPHORE.residues}, critical).`,
    "The fold is an 11-strand beta-barrel around a central helix that carries the chromophore.",
    "Brightness is log10 scale: wild type is 3.72, above 2.5 glows, below 2.5 is dark.",
    "",
    `Current variant: ${describeVariant(input.currentVariant)}`,
    "",
    "Your history:",
    ...(history.length
      ? [
          ...(omitted > 0 ? [`(${omitted} earlier results omitted)`] : []),
          ...history.map((h) => `- round ${h.round}: ${describeVariant(h.variant)} -> ${describeBrightness(h.brightness)}`),
        ]
      : ["- nothing tried yet"]),
    "",
    `Candidates (choose ${input.n} by index):`,
    ...input.candidates.map((c, i) => `[${i}] ${describeVariant(c)}`),
    "",
    `Round ${input.round}. Return JSON: { "picks": [${input.n} distinct integer indices], "reasoning": "two sentences" }`,
  ].join("\n");
}

export interface ParsedMove {
  picks: number[];
  reasoning: string;
}

/** Small models return malformed JSON regularly. Returns null when nothing usable is found. */
export function parseModelResponse(raw: unknown, candidateCount: number, n: number): ParsedMove | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const { picks, reasoning } = obj as { picks?: unknown; reasoning?: unknown };
  if (!Array.isArray(picks)) return null;

  const valid: number[] = [];
  for (const p of picks) {
    const k = typeof p === "string" ? Number(p) : p;
    if (typeof k === "number" && Number.isInteger(k) && k >= 0 && k < candidateCount && !valid.includes(k)) valid.push(k);
    if (valid.length === n) break;
  }
  if (valid.length === 0) return null;
  return { picks: valid, reasoning: capReasoning(typeof reasoning === "string" ? reasoning : "") };
}

export function capReasoning(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= MAX_REASONING_CHARS ? clean : `${clean.slice(0, MAX_REASONING_CHARS - 1)}…`;
}

/** Workers AI neuron prices per million tokens (input, output). */
export const NEURON_RATES: Record<string, [number, number]> = {
  "@cf/meta/llama-3.2-3b-instruct": [4625, 30475],
};

export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const [inRate, outRate] = NEURON_RATES[model] ?? [4625, 30475];
  return Math.round(((inputTokens * inRate + outputTokens * outRate) / 1e6) * 100) / 100;
}

/** ~4 characters per token is close enough for budgeting English + mutation codes. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
