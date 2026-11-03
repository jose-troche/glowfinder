import { Hono } from "hono";
import { ApiError, llmConfigured, type Env } from "../env.ts";
import { clientIp, rateLimit } from "../middleware/rateLimit.ts";
import { parseHostnames, signSession } from "../middleware/turnstile.ts";
import type { Deps } from "../index.ts";

/** POST /api/session: Turnstile token -> short-lived session token. */
export function sessionRoutes(deps: Deps) {
  return new Hono<{ Bindings: Env }>().post("/", rateLimit, async (c) => {
    if (!llmConfigured(c.env)) throw new ApiError("LLM_UNAVAILABLE", "The live LLM strategy is not configured here.");
    const body = (await c.req.json().catch(() => null)) as { turnstileToken?: unknown } | null;
    const token = body?.turnstileToken;
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
      throw new ApiError("INVALID_REQUEST", "turnstileToken is required.");
    }
    const hostnames = parseHostnames(c.env.TURNSTILE_HOSTNAMES);
    if (!(await deps.verifyTurnstile(token, c.env.TURNSTILE_SECRET_KEY!, clientIp(c.req.raw), hostnames))) {
      throw new ApiError("TURNSTILE_FAILED", "Challenge verification failed.");
    }
    const { token: sessionToken, claims } = await signSession(c.env.SESSION_SIGNING_KEY!);
    return c.json({ sessionToken, expiresAt: claims.exp });
  });
}
