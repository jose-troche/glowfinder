// Same race as pipeline/bakeoff.py, through the real TypeScript engine.
// Usage: node scripts/bakeoff.ts [seeds=20] [radius=3]
import { readFile } from "node:fs/promises";
import { loadDataset } from "../src/data/loader.ts";
import { collect, runSimulation, totals } from "../src/sim/engine.ts";
import { LOCAL_STRATEGIES } from "../src/sim/strategies/index.ts";
import { DEFAULT_CONFIG } from "../src/sim/types.ts";

const seeds = Number(process.argv[2] ?? 20);
const config = { ...DEFAULT_CONFIG, radius: Number(process.argv[3] ?? DEFAULT_CONFIG.radius) };
const root = new URL("../data/artifacts/", import.meta.url);
const ds = await loadDataset(async (p) => {
  const bytes = await readFile(new URL(p.replace("/artifacts/", ""), root));
  return { ok: true, status: 200, json: async () => JSON.parse(bytes.toString()), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
});

const sums = new Map<string, { best: number; hit: number; dark: number }>();
for (let s = 0; s < seeds; s++) {
  const results = await collect(runSimulation(ds, LOCAL_STRATEGIES, config, `bakeoff-${s}`));
  for (const st of LOCAL_STRATEGIES) {
    const t = totals(results, st.id)!;
    const acc = sums.get(st.id) ?? { best: 0, hit: 0, dark: 0 };
    acc.best += t.best; acc.hit += t.hitRate; acc.dark += t.dark;
    sums.set(st.id, acc);
  }
}
console.log(`radius ${config.radius}, ${config.rounds} x ${config.proposalsPerRound}, ${seeds} seeds`);
for (const [id, a] of sums) {
  console.log(`${id.padStart(12)}  best ${(a.best / seeds).toFixed(3)}  hit rate ${((100 * a.hit) / seeds).toFixed(1)}%  dark ${(a.dark / seeds).toFixed(1)}`);
}
