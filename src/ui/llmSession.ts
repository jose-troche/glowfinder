// Live LLM plumbing: one Turnstile challenge per race -> session token -> /api/llm-move.

import { LlmError, type ExemplarRun, type LlmErrorCode, type LlmTransport } from "../sim/strategies/llm.ts";

export interface ApiConfig {
  available: boolean;
  configured: boolean;
  model: string;
  turnstileSiteKey: string;
}

/** null when there is no Worker (e.g. a static preview): the recorded run still works. */
export async function fetchApiConfig(): Promise<ApiConfig | null> {
  try {
    const res = await fetch("/api/config", { headers: { Accept: "application/json" } });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    return ((await res.json()) as { llm: ApiConfig }).llm;
  } catch {
    return null;
  }
}

export async function fetchExemplar(): Promise<ExemplarRun | null> {
  try {
    const res = await fetch("/artifacts/exemplar-llm-run.json");
    return res.ok ? ((await res.json()) as ExemplarRun) : null;
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      remove(id: string): void;
    };
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoading: Promise<void> | undefined;

function loadTurnstile(): Promise<void> {
  return (scriptLoading ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptLoading = undefined;
      reject(new LlmError("TURNSTILE_FAILED", "Could not load the challenge."));
    };
    document.head.appendChild(s);
  }));
}

export async function solveTurnstile(siteKey: string, container: HTMLElement): Promise<string> {
  await loadTurnstile();
  container.hidden = false;
  return new Promise((resolve, reject) => {
    const id = window.turnstile!.render(container, {
      sitekey: siteKey,
      theme: "dark",
      callback: (token: string) => {
        window.turnstile!.remove(id);
        container.hidden = true;
        resolve(token);
      },
      "error-callback": () => reject(new LlmError("TURNSTILE_FAILED", "Challenge failed.")),
      "expired-callback": () => reject(new LlmError("TURNSTILE_FAILED", "Challenge expired.")),
    });
  });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    throw new LlmError("NETWORK", (err as Error).message);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: LlmErrorCode; message: string } } & T;
  if (!res.ok) throw new LlmError(data.error?.code ?? "NETWORK", data.error?.message ?? `HTTP ${res.status}`);
  return data;
}

export async function createSession(turnstileToken: string): Promise<string> {
  const { sessionToken } = await post<{ sessionToken: string }>("/api/session", { turnstileToken });
  return sessionToken;
}

export function httpTransport(sessionToken: string): LlmTransport {
  return (req) => post("/api/llm-move", { sessionToken, ...req });
}
