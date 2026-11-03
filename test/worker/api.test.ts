import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { counter } from "../../worker/budget/NeuronCounter.ts";
import type { Env } from "../../worker/env.ts";
import { createApp, type Deps, type ModelResult } from "../../worker/index.ts";
import { signSession } from "../../worker/middleware/turnstile.ts";

const testEnv = env as unknown as Env;
let ipCounter = 0;

function harness(model: Partial<ModelResult> | (() => Promise<ModelResult>) = { response: '{"picks":[0,2,1],"reasoning":"Keep the barrel intact."}' }) {
  const runModel = vi.fn<Deps["runModel"]>(typeof model === "function" ? model : async () => ({ usage: { prompt_tokens: 900, completion_tokens: 60 }, ...model }));
  const verifyTurnstile = vi.fn<Deps["verifyTurnstile"]>(async (token) => token === "good-token");
  const app = createApp({ runModel, verifyTurnstile });
  const ip = `203.0.113.${++ipCounter}`; // fresh rate-limit key per test

  async function call(path: string, body?: unknown, overrides: Partial<Env> = {}) {
    const ctx = createExecutionContext();
    const init: RequestInit = body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) };
    const res = await app.fetch(
      new Request(`https://glowfinder.test${path}`, { ...init, headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip } }),
      { ...testEnv, ...overrides },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  async function session() {
    const r = await call("/api/session", { turnstileToken: "good-token" });
    expect(r.status).toBe(200);
    return r.json.sessionToken as string;
  }

  return { call, session, runModel, verifyTurnstile };
}

const move = (sessionToken: string, extra: Record<string, unknown> = {}) => ({
  sessionToken,
  currentVariant: [],
  candidates: [[2181], [2181, 3022], [41], [300, 900]],
  history: [],
  round: 1,
  n: 3,
  ...extra,
});

async function resetBudget(spend = 0) {
  const stub = counter(testEnv.NEURON_COUNTER);
  const status = await stub.status(Number(testEnv.NEURON_DAILY_BUDGET));
  await stub.adjust(spend - status.spent);
}

beforeEach(() => resetBudget(0));

describe("GET /api/config", () => {
  it("advertises the site key and availability", async () => {
    const { call } = harness();
    const r = await call("/api/config");
    expect(r.status).toBe(200);
    expect(r.json.llm).toMatchObject({ available: true, configured: true, turnstileSiteKey: expect.any(String) });
  });
});

describe("POST /api/session (Turnstile)", () => {
  it("Turnstile failure returns 403 and never reaches the AI binding", async () => {
    const { call, runModel, verifyTurnstile } = harness();
    const r = await call("/api/session", { turnstileToken: "bad-token" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("TURNSTILE_FAILED");
    expect(verifyTurnstile).toHaveBeenCalledWith("bad-token", "test-secret", expect.stringMatching(/^203\.0\.113\./), ["app.test", "www.app.test"]);
    expect(runModel).not.toHaveBeenCalled();
  });

  it("requires a token", async () => {
    const r = await harness().call("/api/session", {});
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("INVALID_REQUEST");
  });

  it("issues a session token on success", async () => {
    const { call } = harness();
    const r = await call("/api/session", { turnstileToken: "good-token" });
    expect(r.json.sessionToken).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(r.json.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("POST /api/llm-move", () => {
  it("returns picks and reasoning for a valid session", async () => {
    const h = harness();
    const r = await h.call("/api/llm-move", move(await h.session()));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ picks: [0, 2, 1], reasoning: "Keep the barrel intact." });
    expect(r.json.fallback).toBeUndefined();
    expect(r.json.neuronsEstimated).toBeGreaterThan(0);
    expect(h.runModel).toHaveBeenCalledTimes(1);
  });

  it("constrains the model with a JSON schema sized to the request", async () => {
    const h = harness();
    await h.call("/api/llm-move", move(await h.session(), { candidates: [[41], [300], [2181], [4000]], n: 2 }));
    const format = h.runModel.mock.calls[0]![3];
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.required).toEqual(["reasoning", "picks"]);
    expect(format.json_schema.properties.picks).toMatchObject({ minItems: 2, maxItems: 2, items: { minimum: 0, maximum: 3 } });
  });

  it("bills the neurons Workers AI reports when it reports them", async () => {
    const h = harness({ response: { picks: [0], reasoning: "r" }, usage: { prompt_tokens: 900, completion_tokens: 80, neurons: 6.3184 } });
    const r = await h.call("/api/llm-move", move(await h.session(), { n: 1 }));
    expect(r.json.neuronsEstimated).toBe(6.32);
    expect(r.json.fallback).toBeUndefined();
    // reservation + correction is a float sum; the reported total is rounded
    expect((await h.call("/api/config")).json.llm.budget.spent).toBe(6.32);
  });

  it("one Turnstile session covers a whole run", async () => {
    const h = harness();
    const token = await h.session();
    for (let round = 1; round <= 3; round++) {
      expect((await h.call("/api/llm-move", move(token, { round }))).status).toBe(200);
    }
    expect(h.verifyTurnstile).toHaveBeenCalledTimes(1);
  });

  it("the prompt carries revealed history but no untried brightness", async () => {
    const h = harness();
    const history = [{ variant: [2181], brightness: 3.41, round: 1 }];
    await h.call("/api/llm-move", move(await h.session(), { history, round: 2, candidates: [[41], [300]], n: 1 }));
    const prompt = h.runModel.mock.calls[0]![2].map((m) => m.content).join("\n");
    expect(prompt).toContain("3.41 glows");
    expect(prompt.match(/\d\.\d\d (glows|DARK)/g)).toHaveLength(1);
  });

  describe("rejects requests whose candidates carry score fields", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["object candidates with brightness", { candidates: [{ variant: [41], brightness: 3.9 }, [300]] }],
      ["object candidates with score", { candidates: [[41], { codes: [300], score: 0.8 }] }],
      ["non-integer entries", { candidates: [[41, 3.92]] }],
      ["a side-channel field", { candidateScores: [3.9, 1.3] }],
      ["history entries with extra fields", { history: [{ variant: [41], brightness: 3.1, round: 1, untried: [[300, 4.0]] }] }],
    ];
    it.each(cases)("%s", async (_, extra) => {
      const h = harness();
      const r = await h.call("/api/llm-move", move(await h.session(), extra));
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("INVALID_REQUEST");
      expect(h.runModel).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["missing", undefined],
    ["forged", "eyJzaWQiOiJ4IiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.AAAA"],
  ])("a %s session returns 401 and never reaches the AI binding", async (_, token) => {
    const h = harness();
    const r = await h.call("/api/llm-move", move(token as string));
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("SESSION_EXPIRED");
    expect(h.runModel).not.toHaveBeenCalled();
  });

  it("an expired session returns 401", async () => {
    const h = harness();
    const { token } = await signSession("test-signing-key", Date.now() - 2 * 60 * 60 * 1000);
    const r = await h.call("/api/llm-move", move(token));
    expect(r.json.error.code).toBe("SESSION_EXPIRED");
  });

  it("falls back to random picks when the model returns malformed JSON", async () => {
    const h = harness({ response: "Sure! I would pick the first one because" });
    const r = await h.call("/api/llm-move", move(await h.session()));
    expect(r.status).toBe(200);
    expect(r.json.fallback).toBe(true);
    expect(new Set(r.json.picks).size).toBe(3);
    for (const p of r.json.picks) expect(p).toBeLessThan(4);
  });

  it("caps reasoning length", async () => {
    const h = harness({ response: JSON.stringify({ picks: [1], reasoning: "x ".repeat(2000) }) });
    const r = await h.call("/api/llm-move", move(await h.session()));
    expect(r.json.reasoning.length).toBeLessThanOrEqual(600);
  });
});

describe("circuit breaker", () => {
  it("returns AI_BUDGET_EXHAUSTED at the threshold and never reaches the AI binding", async () => {
    const h = harness();
    const token = await h.session();
    await resetBudget(Number(testEnv.NEURON_DAILY_BUDGET));
    const r = await h.call("/api/llm-move", move(token));
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("AI_BUDGET_EXHAUSTED");
    expect(h.runModel).not.toHaveBeenCalled();
    expect((await h.call("/api/config")).json.llm.available).toBe(false);
  });

  it("records spend so repeated calls eventually trip the breaker", async () => {
    // the spec's per-call profile: ~1,500 input and ~400 output tokens, ~19 neurons
    const h = harness({ response: '{"picks":[0],"reasoning":"r"}', usage: { prompt_tokens: 1500, completion_tokens: 400 } });
    const token = await h.session();
    let tripped = false;
    let calls = 0;
    for (let round = 1; round <= 10 && !tripped; round++) {
      const r = await h.call("/api/llm-move", move(token, { round }));
      tripped = r.json.error?.code === "AI_BUDGET_EXHAUSTED";
      if (!tripped) calls++;
    }
    // budget is 100 neurons in tests: five calls fit, the sixth trips
    expect(tripped).toBe(true);
    expect(calls).toBe(5);
    const status = await counter(testEnv.NEURON_COUNTER).status(100);
    expect(status.spent).toBeLessThanOrEqual(100);
  });
});

describe("rate limiting", () => {
  it("returns RATE_LIMITED past 12 requests a minute from one IP", async () => {
    const h = harness();
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await h.call("/api/session", { turnstileToken: "good-token" })).status);
    expect(codes.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("unconfigured deployment", () => {
  it("answers LLM_UNAVAILABLE without secrets", async () => {
    const h = harness();
    const r = await h.call("/api/session", { turnstileToken: "good-token" }, { TURNSTILE_SECRET_KEY: undefined });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("LLM_UNAVAILABLE");
    const cfg = await h.call("/api/config", undefined, { SESSION_SIGNING_KEY: undefined });
    expect(cfg.json.llm.available).toBe(false);
  });

  it("unknown API routes are JSON errors", async () => {
    const r = await harness().call("/api/nope");
    expect(r.status).toBe(400);
  });
});
