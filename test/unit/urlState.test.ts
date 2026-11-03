import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/sim/types.ts";
import { DEFAULT_STRATEGIES, parseSettings, sanitizeSeed, serializeSettings } from "../../src/ui/urlState.ts";

const fallback = () => "fallback";

describe("shareable URLs", () => {
  it("round-trips settings", () => {
    const s = { seed: "abc-1", config: { rounds: 7, proposalsPerRound: 4, radius: 5 }, strategies: ["random", "llm"] as const, llmMode: "live" as const };
    expect(parseSettings(serializeSettings({ ...s, strategies: [...s.strategies] }), fallback)).toEqual({ ...s, strategies: ["random", "llm"] });
  });

  it("defaults sensibly", () => {
    expect(parseSettings("", fallback)).toEqual({ seed: "fallback", config: DEFAULT_CONFIG, strategies: DEFAULT_STRATEGIES, llmMode: "recorded" });
  });

  it("clamps and filters hostile input", () => {
    const s = parseSettings("?seed=<script>&rounds=9999&n=-3&radius=x&s=random,evil,random", fallback);
    expect(s.seed).toBe("fallback");
    expect(s.config).toEqual({ rounds: 20, proposalsPerRound: 1, radius: DEFAULT_CONFIG.radius });
    expect(s.strategies).toEqual(["random"]);
  });

  it("only records live mode when the LLM is in the race", () => {
    const base = { seed: "s", config: DEFAULT_CONFIG, llmMode: "live" as const };
    expect(serializeSettings({ ...base, strategies: ["random"] })).not.toContain("llm=live");
    expect(serializeSettings({ ...base, strategies: ["llm"] })).toContain("llm=live");
  });

  it("sanitizes seeds", () => {
    expect(sanitizeSeed(" ok_seed-1 ")).toBe("ok_seed-1");
    expect(sanitizeSeed("a b")).toBeNull();
    expect(sanitizeSeed("x".repeat(40))).toHaveLength(32);
  });
});
