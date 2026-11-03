// The LLM strategy. Live: asks the Worker (POST /api/llm-move). Exemplar: replays a
// committed recording through the same rendering path.
//
// The request carries the LLM's own history (tried variants and their revealed
// brightness -- legitimate feedback) and bare mutation-code arrays for the candidates.
// It never carries brightness for untried candidates; the Worker rejects any request
// whose candidates look like they do.

import { variantKey } from "../../data/codec.ts";
import { variantCodes } from "../../data/loader.ts";
import type { Proposal, SimConfig, Strategy, StrategyContext } from "../types.ts";

/** Candidates offered to the model per round: enough to choose from, cheap in tokens. */
export const LLM_CANDIDATES = 24;

export const LLM_LABEL = "LLM";
export const LLM_KNOWS = "General knowledge and reasoning about structure and chemistry";

export interface LlmMoveRequest {
  sessionToken: string;
  currentVariant: number[];
  candidates: number[][];
  history: { variant: number[]; brightness: number; round: number }[];
  round: number;
  n: number;
}

export interface LlmMoveResponse {
  picks: number[];
  reasoning: string;
  neuronsEstimated: number;
  fallback?: boolean;
}

export type LlmErrorCode =
  | "RATE_LIMITED"
  | "TURNSTILE_FAILED"
  | "SESSION_EXPIRED"
  | "AI_BUDGET_EXHAUSTED"
  | "INVALID_REQUEST"
  | "LLM_UNAVAILABLE"
  | "NETWORK";

export class LlmError extends Error {
  readonly code: LlmErrorCode;

  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type LlmTransport = (req: Omit<LlmMoveRequest, "sessionToken">) => Promise<LlmMoveResponse>;

export function buildRequest(ctx: StrategyContext, offered: readonly number[]): Omit<LlmMoveRequest, "sessionToken"> {
  const codes = (i: number) => Array.from(variantCodes(ctx.dataset, i));
  return {
    currentVariant: codes(ctx.current),
    candidates: offered.map(codes),
    history: ctx.history.map((h) => ({ variant: h.codes, brightness: h.brightness, round: h.round })),
    round: ctx.round,
    n: ctx.n,
  };
}

export function createLiveLlmStrategy(transport: LlmTransport, onError?: (err: LlmError) => void): Strategy {
  return {
    id: "llm",
    label: LLM_LABEL,
    knows: LLM_KNOWS,
    async propose(ctx): Promise<Proposal> {
      const offered = ctx.rng.sample(ctx.candidates, LLM_CANDIDATES);
      try {
        const res = await transport(buildRequest(ctx, offered));
        return {
          picks: res.picks.map((k) => offered[k]).filter((v): v is number => v !== undefined),
          reasoning: res.reasoning,
          ...(res.fallback && { fallback: true, fallbackReason: "model reply could not be parsed; random picks" }),
        };
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError("NETWORK", (err as Error).message);
        onError?.(e);
        return { picks: [], fallbackReason: `${e.code}: ${e.message}` };
      }
    },
  };
}

// --- exemplar -------------------------------------------------------------

export interface ExemplarRound {
  round: number;
  /** candidate variants offered to the model, as mutation codes */
  offered: number[][];
  /** indices into offered, exactly as the endpoint returned them */
  picks: number[];
  /** the variants actually played after the engine's validation and any random top-up */
  played: number[][];
  reasoning: string;
  neuronsEstimated: number;
  fallback?: boolean;
  fallbackReason?: string;
}

export interface ExemplarRun {
  recordedAt: string;
  model: string;
  seed: string;
  config: SimConfig;
  note: string;
  rounds: ExemplarRound[];
}

export function createExemplarStrategy(exemplar: ExemplarRun): Strategy {
  return {
    id: "llm",
    label: `${LLM_LABEL} (recorded)`,
    knows: LLM_KNOWS,
    propose(ctx): Proposal {
      const r = exemplar.rounds.find((x) => x.round === ctx.round);
      if (!r) return { picks: [], fallbackReason: "recording has no such round" };
      // Replay what was played, not just what the model said: top-ups drew on the
      // recording's random stream, which playback doesn't reproduce.
      const picks = r.played
        .map((codes) => ctx.dataset.lookup.get(variantKey(codes)))
        .filter((v): v is number => v !== undefined);
      return {
        picks,
        reasoning: r.reasoning,
        ...(r.fallback && { fallback: true, fallbackReason: r.fallbackReason ?? "model reply could not be parsed; random picks" }),
      };
    },
  };
}

/** The recording replays faithfully only under the configuration it was recorded with. */
export function exemplarConfigMatches(exemplar: ExemplarRun, config: SimConfig): boolean {
  return (
    exemplar.config.radius === config.radius &&
    exemplar.config.proposalsPerRound === config.proposalsPerRound &&
    exemplar.config.rounds >= config.rounds
  );
}
