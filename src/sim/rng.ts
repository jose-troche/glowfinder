// Seeded, deterministic randomness. Same seed -> same run, on every machine.
// Each strategy gets its own stream derived from (seed, strategy id), so adding or
// removing a strategy never changes another strategy's run.

export interface Rng {
  /** uniform in [0, 1) */
  next(): number;
  /** uniform integer in [0, n) */
  int(n: number): number;
  /** k distinct items, uniformly, order of selection */
  sample<T>(items: readonly T[], k: number): T[];
  /** k distinct items, probability proportional to weight (successive draws) */
  weightedSample<T>(items: readonly T[], weights: readonly number[], k: number): T[];
}

/** FNV-1a 32-bit, used to turn seed strings into stream seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** sfc32 seeded through splitmix32: small, fast, and well distributed. */
export function createRng(seed: number | string): Rng {
  let s = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  const splitmix = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix(), b = splitmix(), c = splitmix(), d = splitmix();

  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();

  const int = (n: number) => Math.floor(next() * n);

  return {
    next,
    int,
    sample(items, k) {
      const pool = items.slice();
      const out = [];
      for (let i = 0; i < Math.min(k, pool.length); i++) {
        const j = i + int(pool.length - i);
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
        out.push(pool[i]!);
      }
      return out;
    },
    weightedSample(items, weights, k) {
      const w = weights.slice();
      let total = w.reduce((x, y) => x + y, 0);
      const out = [];
      for (let n = 0; n < Math.min(k, items.length) && total > 0; n++) {
        let r = next() * total;
        let j = 0;
        while (j < w.length - 1 && (r >= w[j]! || w[j] === 0)) r -= w[j++]!;
        while (w[j] === 0) j--; // float drift past the last live item
        out.push(items[j]!);
        total -= w[j]!;
        w[j] = 0;
      }
      return out;
    },
  };
}

export function strategyRng(seed: string, strategyId: string): Rng {
  return createRng(`${seed}:${strategyId}`);
}

export function randomSeed(): string {
  return Math.floor(Math.random() * 1e9).toString(36);
}
