"""Stage 1: parse the figshare TSV into a validated variant table.

The assertion in `parse_genotype` is the most important line in the
repository. With a wrong offset every number still looks plausible and every
structural claim is wrong; with the assertion the pipeline refuses to run.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

from .constants import MIN_BARCODES, POSITION_OFFSET, VISIBLE_THRESHOLD

Mutation = tuple[str, int, str]  # (wild-type aa, avGFP position 1-based, mutant aa)

_TOKEN = re.compile(r"^S([A-Z*])(\d+)([A-Z*])$")


class OffsetMismatchError(AssertionError):
    pass


def parse_genotype(field: str, wild_type: str, offset: int = POSITION_OFFSET) -> tuple[Mutation, ...]:
    """'SA108D:SN144D' -> ((A, 110, D), (N, 146, D)), validated against wild_type.

    The leading 'S' marks a substitution. Positions in the file are 0-based
    from S2, hence the +2 offset to reach avGFP numbering."""
    if not isinstance(field, str) or field == "":
        return ()
    mutations = []
    for token in field.split(":"):
        m = _TOKEN.match(token)
        if not m:
            raise ValueError(f"unparseable mutation token {token!r} in {field!r}")
        wt_aa, raw_pos, mut_aa = m.group(1), int(m.group(2)), m.group(3)
        pos = raw_pos + offset
        if not 1 <= pos <= len(wild_type) or wild_type[pos - 1] != wt_aa:
            found = wild_type[pos - 1] if 1 <= pos <= len(wild_type) else "out of range"
            raise OffsetMismatchError(
                f"Offset mismatch at {pos} in {field!r}: TSV says wild-type {wt_aa}, reference has {found}"
            )
        if wt_aa == mut_aa:
            raise ValueError(f"synonymous token {token!r} in {field!r}")
        mutations.append((wt_aa, pos, mut_aa))
    mutations.sort(key=lambda m: m[1])
    positions = [m[1] for m in mutations]
    if len(set(positions)) != len(positions):
        raise ValueError(f"duplicate position in {field!r}")
    return tuple(mutations)


def mutation_string(mutations: tuple[Mutation, ...]) -> str:
    """ProteinGym-style 'A110D:N146D' (avGFP numbering, sorted by position)."""
    return ":".join(f"{w}{p}{m}" for w, p, m in mutations)


def load_tsv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, sep="\t", keep_default_na=False, na_values={"std": [""]})


def clean(tsv: Path, wild_type: str) -> pd.DataFrame:
    raw = load_tsv(tsv)
    expected = ["aaMutations", "uniqueBarcodes", "medianBrightness", "std"]
    if list(raw.columns) != expected:
        raise ValueError(f"unexpected columns {list(raw.columns)}")

    mutations = [parse_genotype(f, wild_type) for f in raw["aaMutations"]]
    df = pd.DataFrame(
        {
            "mutations": mutations,
            "mutation_str": [mutation_string(m) for m in mutations],
            "n_mut": [len(m) for m in mutations],
            "unique_barcodes": raw["uniqueBarcodes"].astype(int),
            # log10 scale. Never average this as if it were linear.
            "median_log_brightness": raw["medianBrightness"].astype(float),
            "std_log_brightness": raw["std"].astype(float),
        }
    )
    df["has_stop"] = [any(m[2] == "*" for m in muts) for muts in mutations]
    df["low_confidence"] = df["unique_barcodes"] < MIN_BARCODES
    df["visible"] = df["median_log_brightness"] > VISIBLE_THRESHOLD

    if df["mutation_str"].duplicated().any():
        dups = df.loc[df["mutation_str"].duplicated(), "mutation_str"].head().tolist()
        raise ValueError(f"duplicate genotypes after parsing, e.g. {dups}")
    if (df["n_mut"] == 0).sum() != 1:
        raise ValueError("expected exactly one wild-type row")
    return df


def wild_type_brightness(df: pd.DataFrame) -> float:
    return float(df.loc[df["n_mut"] == 0, "median_log_brightness"].iloc[0])


def summarize(df: pd.DataFrame) -> dict:
    """Landscape statistics: the clearest illustration of how narrow the peak is."""
    shipped = df[~df["has_stop"]]
    by_depth = []
    for depth, group in shipped.groupby("n_mut"):
        by_depth.append(
            {
                "depth": int(depth),
                "variants": int(len(group)),
                "visible": int(group["visible"].sum()),
                "fractionVisible": round(float(group["visible"].mean()), 4),
                "brighterThanWildType": int((group["median_log_brightness"] > wild_type_brightness(df)).sum()),
            }
        )
    return {
        "genotypesInFile": int(len(df)),
        "withStopCodon": int(df["has_stop"].sum()),
        "variantsShipped": int(len(shipped)),
        "lowConfidenceShipped": int(shipped["low_confidence"].sum()),
        "wildTypeLogBrightness": wild_type_brightness(df),
        "visibleThreshold": VISIBLE_THRESHOLD,
        "fractionVisible": round(float(shipped["visible"].mean()), 4),
        "minLogBrightness": float(shipped["median_log_brightness"].min()),
        "maxLogBrightness": float(shipped["median_log_brightness"].max()),
        "byDepth": by_depth,
    }


def summary_markdown(summary: dict) -> str:
    lines = [
        "# Landscape summary",
        "",
        "Generated by `glowfinder_pipeline.clean` from the raw figshare TSV. Do not edit by hand.",
        "",
        f"- Genotypes in file: **{summary['genotypesInFile']:,}**",
        f"- Containing a stop codon (excluded from the runtime set): **{summary['withStopCodon']:,}**",
        f"- Variants shipped: **{summary['variantsShipped']:,}**, of which "
        f"{summary['lowConfidenceShipped']:,} are seen on a single barcode (flagged, kept)",
        f"- Wild-type log10 brightness: **{summary['wildTypeLogBrightness']:.3f}**",
        f"- Visibly fluorescent (log10 brightness > {summary['visibleThreshold']}): "
        f"**{summary['fractionVisible']:.1%}** of shipped variants",
        "",
        "| Mutations | Variants | Visibly fluorescent | Fraction visible | Brighter than wild type |",
        "|---:|---:|---:|---:|---:|",
    ]
    for row in summary["byDepth"]:
        lines.append(
            f"| {row['depth']} | {row['variants']:,} | {row['visible']:,} | "
            f"{row['fractionVisible']:.1%} | {row['brighterThanWildType']:,} |"
        )
    return "\n".join(lines) + "\n"
