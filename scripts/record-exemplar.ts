// Record one complete live LLM run and commit it as data/artifacts/exemplar-llm-run.json.
//
//   npm run build && npx wrangler dev --port 8787      (in another terminal)
//   node scripts/record-exemplar.ts [baseUrl] [seed]
//
// Uses the real engine and the real /api/llm-move endpoint (Workers AI, ~20 neurons per
// round). With the test Turnstile secret from .dev.vars.example any token verifies.

import { readFile, writeFile } from "node:fs/promises";
import { loadDataset } from "../src/data/loader.ts";
import { collect, runSimulation, totals } from "../src/sim/engine.ts";
import { createLiveLlmStrategy, type ExemplarRound, type ExemplarRun, type LlmMoveResponse } from "../src/sim/strategies/llm.ts";
import { DEFAULT_CONFIG } from "../src/sim/types.ts";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const seed = process.argv[3] ?? "exemplar";
const artifacts = new URL("../data/artifacts/", import.meta.url);

const ds = await loadDataset(async (p) => {
  const bytes = await readFile(new URL(p.replace("/artifacts/", ""), artifacts));
  return { ok: true, status: 200, json: async () => JSON.parse(bytes.toString()), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
});

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error?.code} ${json.error?.message}`);
  return json;
}

const config = (await (await fetch(`${base}/api/config`)).json()) as { llm: { model: string; available: boolean } };
if (!config.llm.available) throw new Error("live LLM not available on " + base);
const { sessionToken } = await post<{ sessionToken: string }>("/api/session", { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" });

const rounds: ExemplarRound[] = [];
const llm = createLiveLlmStrategy(
  async (req) => {
    const res = await post<LlmMoveResponse>("/api/llm-move", { sessionToken, ...req });
    rounds.push({
      round: req.round,
      offered: req.candidates,
      picks: res.picks,
      played: [], // filled from the engine's results below
      reasoning: res.reasoning,
      neuronsEstimated: res.neuronsEstimated,
    });
    console.log(`round ${req.round}: picks ${res.picks.join(",")}${res.fallback ? " (fallback)" : ""} - ${res.reasoning.slice(0, 100)}`);
    return res;
  },
  (err) => {
    throw err;
  },
);

const results = await collect(runSimulation(ds, [llm], DEFAULT_CONFIG, seed));
const t = totals(results, "llm")!;
for (const r of rounds) {
  const played = results[r.round - 1]!.perStrategy.llm!;
  r.played = played.proposals.map((p) => p.codes);
  if (played.fallback) Object.assign(r, { fallback: true, fallbackReason: played.fallbackReason });
}
const exemplar: ExemplarRun = {
  recordedAt: new Date().toISOString(),
  model: config.llm.model,
  seed,
  config: DEFAULT_CONFIG,
  note:
    "One complete live run of the LLM strategy through /api/llm-move, recorded with scripts/record-exemplar.ts. " +
    "Picks index into each round's offered candidates; replayed through the same engine and rendering path.",
  rounds,
};
await writeFile(new URL("exemplar-llm-run.json", artifacts), JSON.stringify(exemplar, null, 1) + "\n");
console.log(`recorded ${rounds.length} rounds: best ${t.best.toFixed(3)}, dark ${t.dark}/${t.proposals}, fallback rounds ${t.fallbackRounds}`);
