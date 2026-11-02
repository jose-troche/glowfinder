"""M3: run the three non-LLM strategies offline against the real data.

This is the "does the premise hold?" check, done before any UI exists. It
mirrors the rules of src/sim/engine.ts (neighbourhood radius, proposals per
round, greedy selection) but is not bit-for-bit identical -- the RNGs differ.
The TypeScript engine has its own regression test for the central claim.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy import sparse

from .constants import AA_INDEX, REPO_ROOT, SEQ_LEN, VISIBLE_THRESHOLD
from .encode import runtime_table
from .esm_score import log_ratio_matrix

STRATEGIES = ("random", "conservative", "esm", "profile")
MODEL_STRATEGIES = ("esm", "profile")  # rank the neighbourhood by a precomputed matrix
CONSERVATIVE_TEMPERATURE = 2.0


@dataclass
class Landscape:
    codes: sparse.csr_matrix  # variants x (SEQ_LEN * 20), one-hot mutation codes
    positions: sparse.csr_matrix  # variants x SEQ_LEN, one-hot mutated positions
    depth: np.ndarray
    brightness: np.ndarray
    scores: dict[str, np.ndarray]  # strategy -> additive model score per variant
    blosum: np.ndarray

    def distances(self, i: int) -> np.ndarray:
        """Positions at which each variant's sequence differs from variant i's."""
        shared_pos = self.positions @ self.positions[i].T
        shared_code = self.codes @ self.codes[i].T
        return self.depth + self.depth[i] - shared_pos.toarray().ravel() - shared_code.toarray().ravel()


@dataclass
class Config:
    rounds: int = 10
    proposals: int = 5
    radius: int = 3
    selection: str = "greedy"  # or "always-move"


@dataclass
class Run:
    best: list[float] = field(default_factory=list)  # best-so-far after each round
    hits: int = 0
    dark: int = 0


def load_blosum() -> tuple[str, np.ndarray]:
    data = json.loads((REPO_ROOT / "src" / "sim" / "blosum62.json").read_text())
    return data["order"], np.array(data["matrix"])


def build_landscape(clean_df: pd.DataFrame, matrices: dict[str, np.ndarray], wild_type: str) -> Landscape:
    """matrices: strategy name -> 238 x 20 log-probability matrix (AA_ORDER columns)."""
    table = runtime_table(clean_df)
    ratios = {name: log_ratio_matrix(m, wild_type) for name, m in matrices.items()}
    order, blosum = load_blosum()
    bidx = {aa: i for i, aa in enumerate(order)}

    rows, code_cols, pos_cols, blo = [], [], [], []
    scores: dict[str, list[float]] = {name: [] for name in matrices}
    for i, muts in enumerate(table["mutations"]):
        for name, r in ratios.items():
            scores[name].append(sum(r[p - 1, AA_INDEX[m]] for _, p, m in muts))
        blo.append(sum(blosum[bidx[w], bidx[m]] for w, _, m in muts))
        for _, p, m in muts:
            rows.append(i)
            code_cols.append((p - 1) * 20 + AA_INDEX[m])
            pos_cols.append(p - 1)
    n = len(table)
    ones = np.ones(len(rows))
    return Landscape(
        codes=sparse.csr_matrix((ones, (rows, code_cols)), shape=(n, SEQ_LEN * 20)),
        positions=sparse.csr_matrix((ones, (rows, pos_cols)), shape=(n, SEQ_LEN)),
        depth=table["n_mut"].to_numpy(),
        brightness=table["median_log_brightness"].to_numpy(),
        scores={name: np.array(v) for name, v in scores.items()},
        blosum=np.array(blo, dtype=float),
    )


def propose(strategy: str, land: Landscape, eligible: np.ndarray, n: int, rng: np.random.Generator) -> np.ndarray:
    n = min(n, len(eligible))
    if strategy == "random":
        return rng.choice(eligible, n, replace=False)
    if strategy == "conservative":
        w = np.exp(land.blosum[eligible] / CONSERVATIVE_TEMPERATURE)
        return rng.choice(eligible, n, replace=False, p=w / w.sum())
    if strategy in MODEL_STRATEGIES:
        score = land.scores[strategy][eligible]
        order = np.lexsort((eligible, -score))  # best score first, ties by index
        return eligible[order[:n]]
    raise ValueError(strategy)


def simulate(strategy: str, land: Landscape, cfg: Config, seed: int) -> Run:
    rng = np.random.default_rng(seed)
    current = 0  # wild type is row 0 of the runtime table
    current_b = best = land.brightness[0]
    tried = np.zeros(len(land.depth), dtype=bool)
    tried[0] = True
    run = Run()
    for _ in range(cfg.rounds):
        # The measured set is sparse away from wild type; widen the
        # neighbourhood until it holds enough untried variants.
        dist = land.distances(current)
        radius = cfg.radius
        while True:
            eligible = np.flatnonzero((dist <= radius) & ~tried)
            if len(eligible) >= cfg.proposals or radius >= SEQ_LEN:
                break
            radius += 1
        picks = propose(strategy, land, eligible, cfg.proposals, rng)
        tried[picks] = True
        b = land.brightness[picks]
        run.hits += int((b > VISIBLE_THRESHOLD).sum())
        run.dark += int((b <= VISIBLE_THRESHOLD).sum())
        top = picks[np.argmax(b)]
        if cfg.selection == "always-move" or land.brightness[top] > current_b:
            current, current_b = top, land.brightness[top]
        best = max(best, b.max())
        run.best.append(float(best))
    return run


def bakeoff(land: Landscape, cfg: Config, seeds: range) -> pd.DataFrame:
    rows = []
    for strategy in STRATEGIES:
        for seed in seeds:
            r = simulate(strategy, land, cfg, seed)
            rows.append(
                {
                    "strategy": strategy,
                    "seed": seed,
                    "finalBest": r.best[-1],
                    "hitRate": r.hits / (r.hits + r.dark),
                    "dark": r.dark,
                    "curve": r.best,
                }
            )
    return pd.DataFrame(rows)


def summarize(results: pd.DataFrame) -> pd.DataFrame:
    return (
        results.groupby("strategy", sort=False)
        .agg(finalBest=("finalBest", "mean"), hitRate=("hitRate", "mean"), dark=("dark", "mean"))
        .reset_index()
    )


def grid(land: Landscape, seeds: range) -> pd.DataFrame:
    """Tuning sweep over neighbourhood radius and selection rule."""
    rows = []
    for radius in (1, 2, 3, 4, 6):
        for selection in ("greedy", "always-move"):
            s = summarize(bakeoff(land, Config(radius=radius, selection=selection), seeds))
            for rec in s.to_dict("records"):
                rows.append({"radius": radius, "selection": selection, **rec})
    return pd.DataFrame(rows)


def report_markdown(chosen: Config, chosen_summary: pd.DataFrame, sweep: pd.DataFrame, n_seeds: int) -> str:
    lines = [
        "# Offline bake-off (M3)",
        "",
        "Generated by `glowfinder_pipeline.bakeoff`. Do not edit by hand.",
        "",
        f"The four non-LLM strategies, {n_seeds} seeds each, against the real measured landscape.",
        f"Chosen configuration: {chosen.rounds} rounds × {chosen.proposals} proposals, neighbourhood radius",
        f"{chosen.radius}, `{chosen.selection}` selection. Dark = log10 brightness ≤ {VISIBLE_THRESHOLD}.",
        "`esm` and `profile` are deterministic (top-N by score), so their seeds all give the same run.",
        "",
        "## What this run decided",
        "",
        "- **ESM-2 does not carry the premise on GFP.** Its within-depth correlation with brightness is",
        "  ~0.05 (see crosscheck-report.md), matching ProteinGym's published ESM-2 numbers for this assay.",
        "  GFP has few relatives in UniRef, so a single-sequence language model has little to go on.",
        "- **An evolutionary profile of GFP's own family does.** It never proposes a dark variant at any",
        "  radius in the sweep below. It was added as a strategy; ESM-2 stays in, honestly reported.",
        "- **Greedy selection**: a strategy only moves to its brightest proposal if it beats the current",
        "  reference. Moving unconditionally lets bad rounds drag a strategy into the dark.",
        "- **Radius 3** is the default. At radius 1–2 nearly everything near wild type glows, so the dark",
        "  space never shows; there, ESM-2's single deterministic path happens to reach a brighter variant",
        "  than the profile despite a lower hit rate. From radius 3 up, random's dark count grows with",
        "  radius while the profile's stays at zero. The radius is a control in the app.",
        "",
        "| Strategy | Mean final best | Mean hit rate | Mean dark proposals (of 50) |",
        "|---|---:|---:|---:|",
    ]
    for r in chosen_summary.to_dict("records"):
        lines.append(f"| {r['strategy']} | {r['finalBest']:.3f} | {r['hitRate']:.1%} | {r['dark']:.1f} |")
    lines += [
        "",
        "## Tuning sweep",
        "",
        "| Radius | Selection | Strategy | Mean final best | Mean hit rate | Mean dark |",
        "|---:|---|---|---:|---:|---:|",
    ]
    for r in sweep.to_dict("records"):
        lines.append(
            f"| {r['radius']} | {r['selection']} | {r['strategy']} | {r['finalBest']:.3f} | "
            f"{r['hitRate']:.1%} | {r['dark']:.1f} |"
        )
    return "\n".join(lines) + "\n"
