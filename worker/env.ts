import type { NeuronCounter } from "./budget/NeuronCounter.ts";

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  LLM_LIMITER: RateLimit;
  NEURON_COUNTER: DurableObjectNamespace<NeuronCounter>;

  AI_MODEL: string;
  NEURON_DAILY_BUDGET: string;
  TURNSTILE_SITE_KEY: string;

  // secrets; absent means the live LLM path is switched off
  TURNSTILE_SECRET_KEY?: string;
  SESSION_SIGNING_KEY?: string;
}

export type ErrorCode =
  | "RATE_LIMITED"
  | "TURNSTILE_FAILED"
  | "SESSION_EXPIRED"
  | "AI_BUDGET_EXHAUSTED"
  | "INVALID_REQUEST"
  | "LLM_UNAVAILABLE";

export const ERROR_STATUS: Record<ErrorCode, 400 | 401 | 403 | 429 | 503> = {
  INVALID_REQUEST: 400,
  SESSION_EXPIRED: 401,
  TURNSTILE_FAILED: 403,
  RATE_LIMITED: 429,
  AI_BUDGET_EXHAUSTED: 503,
  LLM_UNAVAILABLE: 503,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function llmConfigured(env: Env): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY && env.SESSION_SIGNING_KEY);
}
