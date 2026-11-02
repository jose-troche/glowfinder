// Turnstile once per simulation session, not per round: a verified challenge buys a
// short-lived HMAC-signed session token that /api/llm-move accepts for the rest of the run.

import type { MiddlewareHandler } from "hono";
import { ApiError, type Env } from "../env.ts";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SESSION_TTL_MS = 30 * 60 * 1000;

export async function verifyTurnstile(
  token: string,
  secret: string,
  ip: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface SessionClaims {
  sid: string;
  exp: number;
}

export async function signSession(secret: string, now = Date.now()): Promise<{ token: string; claims: SessionClaims }> {
  const claims: SessionClaims = { sid: crypto.randomUUID(), exp: now + SESSION_TTL_MS };
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
  return { token: `${payload}.${b64url(sig)}`, claims };
}

export async function verifySession(token: unknown, secret: string, now = Date.now()): Promise<SessionClaims | null> {
  if (typeof token !== "string" || token.length > 512) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), encoder.encode(payload));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as SessionClaims;
    return typeof claims.exp === "number" && claims.exp > now ? claims : null;
  } catch {
    return null;
  }
}

/** Requires a valid session token in the JSON body's `sessionToken`. Stores the parsed body. */
export const requireSession: MiddlewareHandler<{ Bindings: Env; Variables: { body: unknown } }> = async (c, next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("INVALID_REQUEST", "Body must be JSON.");
  }
  const token = (body as { sessionToken?: unknown } | null)?.sessionToken;
  if (!(await verifySession(token, c.env.SESSION_SIGNING_KEY!))) {
    throw new ApiError("SESSION_EXPIRED", "Session missing or expired; complete the challenge again.");
  }
  c.set("body", body);
  await next();
};
