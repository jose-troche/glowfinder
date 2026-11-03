import { describe, expect, it, vi } from "vitest";
import {
  buildPrompt,
  capReasoning,
  describeMutation,
  estimateNeurons,
  parseModelResponse,
} from "../../worker/ai/prompts.ts";
import { parseHostnames, signSession, verifySession, verifyTurnstile, SITEVERIFY_URL, TURNSTILE_ACTION } from "../../worker/middleware/turnstile.ts";
import { validateMoveBody } from "../../worker/routes/llmMove.ts";

const code = (position: number, aa: string) => (position - 1) * 20 + "ACDEFGHIKLMNPQRSTVWY".indexOf(aa);

describe("prompt context", () => {
  it("labels chromophore, neighbourhood and burial", () => {
    expect(describeMutation(code(66, "H"))).toBe("Y66H (chromophore)");
    expect(describeMutation(code(64, "F"))).toBe("L64F (next to chromophore)");
    expect(describeMutation(code(222, "Q"))).toBe("E222Q (buried)");
    expect(describeMutation(code(3, "R"))).toBe("K3R (surface)");
  });

  it("states the rules and the candidate list", () => {
    const p = buildPrompt({ currentVariant: [], candidates: [[code(3, "R")]], history: [], round: 1, n: 1 });
    expect(p).toContain("You cannot see any brightness values except for");
    expect(p).toContain("[0] K3R (surface)");
    expect(p).toContain("nothing tried yet");
  });
});

describe("parseModelResponse", () => {
  it.each([
    ['{"picks":[1,0],"reasoning":"ok"}', [1, 0]],
    ['```json\n{"picks":[2], "reasoning":"fenced"}\n```', [2]],
    ['I choose: {"picks":["1","3"],"reasoning":"strings"} done', [1, 3]],
    ['{"picks":[0,0,1,9,-1,1.5],"reasoning":"dupes and junk"}', [0, 1]],
  ])("parses %j", (raw, picks) => {
    expect(parseModelResponse(raw, 4, 3)?.picks).toEqual(picks);
  });

  it("accepts an already-parsed object", () => {
    expect(parseModelResponse({ picks: [3], reasoning: "obj" }, 4, 1)).toEqual({ picks: [3], reasoning: "obj" });
  });

  it.each(["", "no json here", '{"picks": "zero"}', '{"picks": [7]}', '{"picks": [1,', "{broken json}"])("rejects %j", (raw) => {
    expect(parseModelResponse(raw, 4, 3)).toBeNull();
  });

  it("truncates to n picks and caps reasoning", () => {
    const r = parseModelResponse({ picks: [0, 1, 2, 3], reasoning: "a".repeat(1000) }, 4, 2)!;
    expect(r.picks).toEqual([0, 1]);
    expect(r.reasoning.length).toBe(600);
    expect(capReasoning("  two   spaces ")).toBe("two spaces");
  });
});

describe("neuron estimate", () => {
  it("matches the spec's arithmetic (~19 neurons per call)", () => {
    expect(estimateNeurons("@cf/meta/llama-3.2-3b-instruct", 1500, 400)).toBeCloseTo(19.13, 1);
  });
});

describe("session tokens", () => {
  it("round-trips and expires", async () => {
    const now = Date.now();
    const { token } = await signSession("k", now);
    expect(await verifySession(token, "k", now + 1000)).not.toBeNull();
    expect(await verifySession(token, "k", now + 31 * 60 * 1000)).toBeNull();
  });

  it("rejects tampering and the wrong key", async () => {
    const { token } = await signSession("k");
    const [payload, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ sid: "x", exp: Date.now() + 1e9 })).replace(/=+$/, "");
    expect(await verifySession(`${forged}.${sig}`, "k")).toBeNull();
    expect(await verifySession(token, "other")).toBeNull();
    expect(await verifySession(`${payload}`, "k")).toBeNull();
    expect(await verifySession(42, "k")).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  const hosts = ["glowfinder.example.dev"];
  const reply = (data: Record<string, unknown>) => vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(data));
  const good = { success: true, action: TURNSTILE_ACTION, hostname: "glowfinder.example.dev" };

  it("posts secret, token and ip to siteverify", async () => {
    const fetchImpl = reply(good);
    expect(await verifyTurnstile("tok", "sec", "1.2.3.4", hosts, fetchImpl as typeof fetch)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(SITEVERIFY_URL);
    const body = init!.body as FormData;
    expect([body.get("secret"), body.get("response"), body.get("remoteip")]).toEqual(["sec", "tok", "1.2.3.4"]);
  });

  it("requires our action and an allowlisted hostname", async () => {
    const check = (data: Record<string, unknown>, h = hosts) => verifyTurnstile("t", "s", undefined, h, reply(data) as unknown as typeof fetch);
    expect(await check({ ...good, action: "login" })).toBe(false);
    expect(await check({ ...good, action: undefined })).toBe(false);
    expect(await check({ ...good, hostname: "evil.example" })).toBe(false);
    expect(await check({ ...good, hostname: undefined })).toBe(false);
    expect(await check(good, [])).toBe(false);
    // Cloudflare's test keys report no action; accepted only when flagged as a testing-key result
    expect(await check({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } }, ["example.com"])).toBe(true);
  });

  it("parses the hostname allowlist", () => {
    expect(parseHostnames(" a.dev, b.dev ,,")).toEqual(["a.dev", "b.dev"]);
    expect(parseHostnames(undefined)).toEqual([]);
  });

  it("fails closed", async () => {
    const no = vi.fn(async () => Response.json({ ...good, success: false }));
    const down = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const throws = vi.fn(async () => {
      throw new Error("network");
    });
    for (const f of [no, down, throws]) expect(await verifyTurnstile("t", "s", undefined, hosts, f as unknown as typeof fetch)).toBe(false);
  });
});

describe("validateMoveBody", () => {
  const base = { sessionToken: "t", currentVariant: [], candidates: [[1], [2]], history: [], round: 1, n: 1 };

  it("accepts a clean body and defaults n", () => {
    const { n: _n, ...noN } = base;
    expect(validateMoveBody({ ...noN, candidates: [[1], [2], [3], [4], [5]] }).n).toBe(5);
  });

  it.each([
    [{ candidates: [] }],
    [{ candidates: Array.from({ length: 41 }, (_, i) => [i]) }],
    [{ candidates: [[4760]] }],
    [{ currentVariant: "wt" }],
    [{ round: 0 }],
    [{ n: 3 }],
  ])("rejects %j", (patch) => {
    expect(() => validateMoveBody({ ...base, ...patch })).toThrow();
  });
});
