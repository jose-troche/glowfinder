import { Hono } from "hono";
import {
  approxTokens,
  buildPrompt,
  estimateNeurons,
  MAX_OUTPUT_TOKENS,
  moveResponseFormat,
  parseModelResponse,
  SYSTEM_PROMPT,
  type MoveInput,
} from "../ai/prompts.ts";
import { counter } from "../budget/NeuronCounter.ts";
import { ApiError, llmConfigured, type Env } from "../env.ts";
import { rateLimit } from "../middleware/rateLimit.ts";
import { requireSession } from "../middleware/turnstile.ts";
import type { Deps } from "../index.ts";

const MAX_CODE = 238 * 20 - 1;
const MAX_CANDIDATES = 40;
const MAX_HISTORY = 500;
const MAX_MUTATIONS = 15;
const ALLOWED_KEYS = new Set(["sessionToken", "currentVariant", "candidates", "history", "round", "n"]);
const HISTORY_KEYS = new Set(["variant", "brightness", "round"]);

function invalid(message: string): never {
  throw new ApiError("INVALID_REQUEST", message);
}

function isCodes(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_MUTATIONS &&
    v.every((c) => Number.isInteger(c) && c >= 0 && c <= MAX_CODE)
  );
}

/**
 * Strict validation. In particular, candidates must be bare mutation-code arrays: a
 * candidate carrying a brightness or score field would leak ground truth and silently
 * invalidate the whole comparison, so it is rejected rather than stripped.
 */
export function validateMoveBody(body: unknown): MoveInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Body must be a JSON object.");
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!ALLOWED_KEYS.has(key)) invalid(`Unexpected field "${key}".`);

  if (!Array.isArray(b.candidates) || b.candidates.length === 0 || b.candidates.length > MAX_CANDIDATES) {
    invalid(`candidates must be an array of 1-${MAX_CANDIDATES} variants.`);
  }
  for (const c of b.candidates) {
    if (!isCodes(c)) {
      invalid("candidates must be bare mutation-code arrays; brightness or score fields are never accepted.");
    }
  }
  if (!isCodes(b.currentVariant)) invalid("currentVariant must be a mutation-code array.");

  const history = b.history ?? [];
  if (!Array.isArray(history) || history.length > MAX_HISTORY) invalid("history must be an array.");
  for (const h of history) {
    if (!h || typeof h !== "object" || Array.isArray(h)) invalid("history entries must be objects.");
    const e = h as Record<string, unknown>;
    if (Object.keys(e).some((k) => !HISTORY_KEYS.has(k))) invalid("history entries hold only variant, brightness, round.");
    if (!isCodes(e.variant) || typeof e.brightness !== "number" || !Number.isFinite(e.brightness) || !Number.isInteger(e.round)) {
      invalid("history entries need variant (codes), brightness (number) and round (integer).");
    }
  }

  const round = b.round;
  if (!Number.isInteger(round) || (round as number) < 1 || (round as number) > 100) invalid("round must be 1-100.");
  const n = b.n ?? 5;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > Math.min(10, b.candidates.length)) {
    invalid("n must be between 1 and min(10, candidates).");
  }
  return {
    currentVariant: b.currentVariant as number[],
    candidates: b.candidates as number[][],
    history: history as MoveInput["history"],
    round: round as number,
    n: n as number,
  };
}

function randomPicks(count: number, n: number): number[] {
  const pool = Array.from({ length: count }, (_, i) => i);
  const r = new Uint32Array(count);
  crypto.getRandomValues(r);
  for (let i = count - 1; i > 0; i--) {
    const j = r[i]! % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

/** POST /api/llm-move. Order: rate limit -> session -> validate -> budget -> model. */
export function llmMoveRoutes(deps: Deps) {
  return new Hono<{ Bindings: Env; Variables: { body: unknown } }>().post(
    "/",
    async (c, next) => {
      if (!llmConfigured(c.env)) throw new ApiError("LLM_UNAVAILABLE", "The live LLM strategy is not configured here.");
      await next();
    },
    rateLimit,
    requireSession,
    async (c) => {
      const input = validateMoveBody(c.get("body"));
      const prompt = buildPrompt(input);
      const model = c.env.AI_MODEL;
      const budget = Number(c.env.NEURON_DAILY_BUDGET);
      const inputTokens = approxTokens(SYSTEM_PROMPT + prompt);
      const reserved = estimateNeurons(model, inputTokens, MAX_OUTPUT_TOKENS);

      const neurons = counter(c.env.NEURON_COUNTER);
      const reservation = await neurons.reserve(reserved, budget);
      if (!reservation.granted) {
        throw new ApiError("AI_BUDGET_EXHAUSTED", "Today's live LLM budget is spent; showing the recorded run instead.");
      }

      const result = await deps.runModel(
        c.env,
        model,
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        moveResponseFormat(input.candidates.length, input.n),
      );
      const outputTokens = result.usage?.completion_tokens ?? approxTokens(typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? ""));
      const reported = result.usage?.neurons;
      const actual =
        typeof reported === "number" && Number.isFinite(reported) && reported >= 0
          ? Math.round(reported * 100) / 100
          : estimateNeurons(model, result.usage?.prompt_tokens ?? inputTokens, outputTokens);
      c.executionCtx.waitUntil(neurons.adjust(actual - reserved));

      const parsed = parseModelResponse(result.response, input.candidates.length, input.n);
      if (!parsed) {
        return c.json({
          picks: randomPicks(input.candidates.length, input.n),
          reasoning: "",
          neuronsEstimated: actual,
          fallback: true,
        });
      }
      return c.json({ picks: parsed.picks, reasoning: parsed.reasoning, neuronsEstimated: actual });
    },
  );
}
