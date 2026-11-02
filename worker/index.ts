// The Worker does almost nothing: static assets (the app and the pipeline artifacts)
// are served by the platform without invoking it. Only /api/* runs code, and only the
// LLM strategy costs anything.

import { Hono } from "hono";
import { MAX_OUTPUT_TOKENS } from "./ai/prompts.ts";
import { counter, NeuronCounter } from "./budget/NeuronCounter.ts";
import { ApiError, ERROR_STATUS, llmConfigured, type Env } from "./env.ts";
import { verifyTurnstile } from "./middleware/turnstile.ts";
import { llmMoveRoutes } from "./routes/llmMove.ts";
import { sessionRoutes } from "./routes/session.ts";

export interface ModelResult {
  response?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Seams for tests: the outside world the Worker talks to. */
export interface Deps {
  verifyTurnstile: (token: string, secret: string, ip: string | undefined) => Promise<boolean>;
  runModel: (env: Env, model: string, messages: { role: "system" | "user"; content: string }[]) => Promise<ModelResult>;
}

export const defaultDeps: Deps = {
  verifyTurnstile: (token, secret, ip) => verifyTurnstile(token, secret, ip),
  runModel: async (env, model, messages) =>
    (await env.AI.run(model as keyof AiModels, {
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4,
    } as never)) as ModelResult,
};

export function createApp(deps: Deps = defaultDeps) {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, ERROR_STATUS[err.code]);
    }
    console.error(err);
    return c.json({ error: { code: "INTERNAL", message: "Unexpected error." } }, 500);
  });

  app.get("/api/config", async (c) => {
    const configured = llmConfigured(c.env);
    const budget = Number(c.env.NEURON_DAILY_BUDGET);
    const status = configured ? await counter(c.env.NEURON_COUNTER).status(budget) : null;
    return c.json({
      llm: {
        available: configured && !status?.exhausted,
        configured,
        model: c.env.AI_MODEL,
        turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
        budget: status,
      },
    });
  });

  app.route("/api/session", sessionRoutes(deps));
  app.route("/api/llm-move", llmMoveRoutes(deps));
  app.all("/api/*", () => {
    throw new ApiError("INVALID_REQUEST", "No such endpoint.");
  });
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

export { NeuronCounter };

export default createApp();
