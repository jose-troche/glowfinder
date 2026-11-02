// Per-IP rate limit on the paid endpoints. Enforced per Cloudflare location, so a
// distributed client gets a higher effective limit: a loose filter, not abuse prevention.
// The neuron circuit breaker is the real backstop.

import type { MiddlewareHandler } from "hono";
import { ApiError, type Env } from "../env.ts";

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}

export const rateLimit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const { success } = await c.env.LLM_LIMITER.limit({ key: clientIp(c.req.raw) });
  if (!success) throw new ApiError("RATE_LIMITED", "Too many requests; try again in a minute.");
  await next();
};
