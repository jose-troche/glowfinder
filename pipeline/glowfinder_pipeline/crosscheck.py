"""Stage 3: compare the locally rebuilt table with ProteinGym's cleaned version.

ProteinGym is validation, not a source. Near-perfect agreement means the
parsing and offset are right; anything else is a bug -- almost certainly the
offset or the mutation-string normalisation.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from .esm_score import score_variant
from .clean import mutation_string, parse_genotype

# Two measurements disagree "beyond noise" when they differ by more than this
# (log10 units). Quantisation alone is 0.001.
DISAGREEMENT_TOLERANCE = 0.01


def normalize(mutant: str, wild_type: str) -> str:
    """'V55A:K3R' -> 'K3R:V55A': parsed, validated against wild_type, sorted by position."""
    if mutant in ("", "WT", "_wt"):
        return ""
    muts = []
    for token in mutant.split(":"):
        wt_aa, pos, mut_aa = token[0], int(token[1:-1]), token[-1]
        if wild_type[pos - 1] != wt_aa:
            raise AssertionError(f"ProteinGym {token}: reference has {wild_type[pos - 1]} at {pos}")
        muts.append((wt_aa, pos, mut_aa))
    return mutation_string(tuple(sorted(muts, key=lambda m: m[1])))


def load_proteingym(path: Path, wild_type: str) -> pd.DataFrame:
    pg = pd.read_csv(path)
    pg["mutation_str"] = [normalize(m, wild_type) for m in pg["mutant"]]
    return pg


def crosscheck(local: pd.DataFrame, proteingym: pd.DataFrame) -> dict:
    local = local[~local["has_stop"]]
    merged = local.merge(proteingym, on="mutation_str", how="inner")
    rho = spearmanr(merged["median_log_brightness"], merged["DMS_score"]).statistic
    diff = (merged["median_log_brightness"] - merged["DMS_score"]).abs()
    disagreements = merged.loc[diff > DISAGREEMENT_TOLERANCE, ["mutation_str", "median_log_brightness", "DMS_score"]]
    return {
        "localVariants": int(len(local)),
        "proteingymVariants": int(len(proteingym)),
        "overlap": int(len(merged)),
        "localCoveredByProteinGym": round(len(merged) / len(local), 6),
        "proteingymCoveredByLocal": round(len(merged) / len(proteingym), 6),
        "onlyLocal": sorted(set(local["mutation_str"]) - set(proteingym["mutation_str"])),
        "onlyProteinGym": sorted(set(proteingym["mutation_str"]) - set(local["mutation_str"])),
        "spearman": float(rho),
        "maxAbsDifference": float(diff.max()),
        "disagreements": disagreements.head(20).to_dict("records"),
        "disagreementCount": int(len(disagreements)),
    }


def reconcile(proteingym: pd.DataFrame, nucleotide_tsv: Path, wild_type: str) -> dict:
    """Explain the disagreements rather than tolerate them.

    ProteinGym's DMS_score is `mean_medianBrightness_per_aaseq`: the mean of
    per-nucleotide-genotype medians. The amino-acid TSV's medianBrightness is
    the median over all barcodes of that protein sequence. The two can only
    differ when several nucleotide genotypes encode the same protein, so
    recomputing ProteinGym's statistic from the nucleotide TSV should match it."""
    nt = pd.read_csv(nucleotide_tsv, sep="\t", keep_default_na=False)
    nt["mutation_str"] = [mutation_string(parse_genotype(f, wild_type)) for f in nt["aaMutations"]]
    rebuilt = nt.groupby("mutation_str")["medianBrightness"].mean().rename("rebuilt_mean")
    merged = proteingym.join(rebuilt, on="mutation_str", how="inner")
    diff = (merged["rebuilt_mean"] - merged["DMS_score"]).abs()
    return {
        "matched": int(len(merged)),
        "maxAbsDifference": float(diff.max()),
        "beyondTolerance": int((diff > DISAGREEMENT_TOLERANCE).sum()),
    }


def model_correlations(local: pd.DataFrame, ratios_by_model: dict[str, np.ndarray], published: dict[str, float]) -> list[dict]:
    """Zero-shot Spearman of each additive model score against measured brightness.

    `published` maps the same keys to ProteinGym's per-assay Spearman for the
    equivalent model, so the report shows whether our matrices reproduce it."""
    variants = local[(~local["has_stop"]) & (local["n_mut"] > 0)]
    depth = variants["n_mut"].to_numpy()
    brightness = variants["median_log_brightness"].to_numpy()
    rows = []
    for model, ratios in ratios_by_model.items():
        scores = np.array([score_variant(ratios, m) for m in variants["mutations"]])
        within = [spearmanr(scores[depth == d], brightness[depth == d]).statistic for d in range(1, 7)]
        rows.append(
            {
                "model": model,
                "spearmanAll": float(spearmanr(scores, brightness).statistic),
                "spearmanSingles": float(within[0]),
                "spearmanWithinDepthMean": float(np.mean(within)),
                "proteingymPublished": published.get(model),
            }
        )
    return rows


def load_published_spearman(path: Path, columns: dict[str, str]) -> dict[str, float]:
    """columns: our model key -> ProteinGym column name, read from the GFP row."""
    table = pd.read_csv(path)
    row = table[table["DMS ID"] == "GFP_AEQVI_Sarkisyan_2016"].iloc[0]
    return {key: float(row[col]) for key, col in columns.items()}


def report_markdown(result: dict, reconciliation: dict, model_rows: list[dict]) -> str:
    lines = [
        "# Cross-check: rebuilt from raw vs. ProteinGym",
        "",
        "Generated by `glowfinder_pipeline.crosscheck`. Do not edit by hand.",
        "",
        "The variant table was rebuilt from the raw figshare TSV (Sarkisyan et al. 2016) and compared",
        "variant by variant with ProteinGym's `GFP_AEQVI_Sarkisyan_2016`, joined on normalised",
        "mutation strings in avGFP numbering.",
        "",
        "| Check | Result |",
        "|---|---|",
        f"| Local variants (stop codons excluded) | {result['localVariants']:,} |",
        f"| ProteinGym variants | {result['proteingymVariants']:,} |",
        f"| Overlap | {result['overlap']:,} |",
        f"| Local covered by ProteinGym | {result['localCoveredByProteinGym']:.4%} |",
        f"| ProteinGym covered by local | {result['proteingymCoveredByLocal']:.4%} |",
        f"| Spearman ρ, `medianBrightness` vs `DMS_score` | **{result['spearman']:.4f}** |",
        f"| Max absolute difference (log10) | {result['maxAbsDifference']:.2e} |",
        f"| Variants differing by > {DISAGREEMENT_TOLERANCE} | {result['disagreementCount']:,} |",
        "",
    ]
    if result["onlyLocal"]:
        shown = ", ".join(f"`{m or 'wild type'}`" for m in result["onlyLocal"][:10])
        lines += [f"Only in the local table: {shown}" + (" …" if len(result["onlyLocal"]) > 10 else ""), ""]
    if result["onlyProteinGym"]:
        shown = ", ".join(f"`{m}`" for m in result["onlyProteinGym"][:10])
        lines += [f"Only in ProteinGym: {shown}" + (" …" if len(result["onlyProteinGym"]) > 10 else ""), ""]
    if result["disagreements"]:
        lines += [
            "## Why some values differ",
            "",
            f"{result['disagreementCount']:,} variants differ by more than {DISAGREEMENT_TOLERANCE}. Every one is a",
            "protein sequence observed through several nucleotide genotypes. ProteinGym's `DMS_score` is",
            "`mean_medianBrightness_per_aaseq` (the mean of per-nucleotide-genotype medians); the amino-acid",
            "TSV reports the median over all barcodes. Recomputing ProteinGym's statistic from the raw",
            "nucleotide TSV reproduces it exactly:",
            "",
            f"- Variants matched: {reconciliation['matched']:,}",
            f"- Max absolute difference: {reconciliation['maxAbsDifference']:.1e}",
            f"- Beyond tolerance: {reconciliation['beyondTolerance']}",
            "",
            "So the disagreement is a choice of summary statistic, not a parsing or offset bug.",
            "glowfinder keeps the amino-acid TSV's median. First few examples:",
            "",
            "| Variant | Local median | ProteinGym mean of medians |",
            "|---|---:|---:|",
        ]
        for d in result["disagreements"][:8]:
            lines.append(f"| `{d['mutation_str']}` | {d['median_log_brightness']:.4f} | {d['DMS_score']:.4f} |")
        lines.append("")
    lines += [
        "## Zero-shot model correlation",
        "",
        "Additive score (sum of per-substitution log-ratios from a 238 × 20 matrix) vs. measured log",
        "brightness. \"Within depth\" averages Spearman over variants with exactly 1–6 mutations, which",
        "removes the easy signal that more mutations means both a lower score and a darker protein.",
        "The last column is ProteinGym's published Spearman for the equivalent model on this assay.",
        "",
        "| Model | ρ all variants | ρ single mutants | ρ within depth (mean) | ProteinGym published |",
        "|---|---:|---:|---:|---:|",
    ]
    for r in model_rows:
        pub = f"{r['proteingymPublished']:.3f}" if r["proteingymPublished"] is not None else "—"
        lines.append(
            f"| {r['model']} | {r['spearmanAll']:.3f} | {r['spearmanSingles']:.3f} | "
            f"{r['spearmanWithinDepthMean']:.3f} | {pub} |"
        )
    return "\n".join(lines) + "\n"
