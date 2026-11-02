"""One command, every stage: `uv run glowfinder-pipeline` from pipeline/.

download -> reference -> clean -> models -> cross-check -> encode -> bake-off -> provenance
"""

from __future__ import annotations

import argparse
import shutil
import sys

import numpy as np

from . import bakeoff, clean, crosscheck, download, encode, esm_score, evolution, reference
from .constants import (
    AA_ORDER,
    ARTIFACTS_DIR,
    BUILD_DIR,
    PIPELINE_DIR,
    PIPELINE_VERSION,
    POSITION_OFFSET,
    RAW_DIR,
    VISIBLE_THRESHOLD,
)

# Cross-check gates (implementation M2: do not proceed until this agrees).
MIN_CROSSCHECK_SPEARMAN = 0.999


def log(msg: str) -> None:
    print(f"[glowfinder] {msg}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="glowfinder-pipeline", description=__doc__)
    parser.add_argument("--esm-model", default=esm_score.DEFAULT_MODEL, help="shipped ESM-2 checkpoint")
    parser.add_argument("--esm-method", default="masked-marginal", choices=esm_score.SCORING_METHODS)
    parser.add_argument(
        "--compare-model",
        action="append",
        default=[esm_score.SMALL_MODEL],
        help="extra ESM-2 checkpoints scored for the report only (repeatable)",
    )
    parser.add_argument("--seeds", type=int, default=20, help="bake-off seeds per strategy")
    parser.add_argument("--force-download", action="store_true")
    args = parser.parse_args(argv)

    log("stage 0: download")
    paths = download.fetch_all(force=args.force_download)

    log("stage 1: reference + clean (+2 offset, validated against the construct)")
    ref = reference.build_reference(paths["uniprot_p42212"], paths["sarkisyan_reference_dna"], paths["alphafold_p42212"])
    wild_type = ref["sequence"]
    df = clean.clean(paths["sarkisyan_aa_genotypes"], wild_type)
    summary = clean.summarize(df)
    (PIPELINE_DIR / "landscape-summary.md").write_text(clean.summary_markdown(summary))
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    df.drop(columns="mutations").to_parquet(BUILD_DIR / "clean_variants.parquet")  # mutation_str carries them
    log(f"  {summary['variantsShipped']:,} variants, {summary['fractionVisible']:.1%} visibly fluorescent")

    log(f"stage 2: ESM-2 ({args.esm_model}, {args.esm_method}) + evolutionary profile")
    esm_matrix = esm_score.score_matrix(wild_type, args.esm_model, args.esm_method)
    unmasked = esm_score.wild_type_log_probs(wild_type, args.esm_model)
    agreement = esm_score.argmax_agreement(unmasked, wild_type)
    if agreement < 0.9:
        raise esm_score.SpecialTokenError(f"unmasked argmax matches wild type at only {agreement:.1%} of positions")
    profile_matrix, profile_meta = evolution.profile_log_probs(paths["proteingym_gfp_msa"].read_text(), wild_type)

    log("stage 3: cross-check vs ProteinGym")
    pg = crosscheck.load_proteingym(paths["proteingym_gfp"], wild_type)
    result = crosscheck.crosscheck(df, pg)
    reconciliation = crosscheck.reconcile(pg, paths["sarkisyan_nt_genotypes"], wild_type)
    if result["spearman"] < MIN_CROSSCHECK_SPEARMAN or result["proteingymCoveredByLocal"] < 1.0:
        raise AssertionError(f"cross-check failed: {result['spearman']=}, {result['proteingymCoveredByLocal']=}")
    if reconciliation["beyondTolerance"]:
        raise AssertionError(f"{reconciliation['beyondTolerance']} disagreements are not explained by the summary statistic")

    short = lambda m: m.split("/")[-1]  # noqa: E731
    shipped_esm = f"ESM-2 {short(args.esm_model)}, {args.esm_method} (shipped)"
    ratios = {
        shipped_esm: esm_score.log_ratio_matrix(esm_matrix, wild_type),
        f"ESM-2 {short(args.esm_model)}, wild-type-marginal": esm_score.log_ratio_matrix(unmasked, wild_type),
    }
    for model in args.compare_model:
        if model != args.esm_model:
            m = esm_score.score_matrix(wild_type, model, args.esm_method)
            ratios[f"ESM-2 {short(model)}, {args.esm_method}"] = esm_score.log_ratio_matrix(m, wild_type)
    ratios["Evolutionary profile (shipped)"] = esm_score.log_ratio_matrix(profile_matrix, wild_type)

    proteingym_columns = {"Evolutionary profile (shipped)": "Site-Independent"}
    for key in ratios:
        for size in ("8M", "35M", "150M", "650M"):
            if f"_{size}_" in key and args.esm_method in key:
                proteingym_columns[key] = f"ESM2 ({size})"
    published = crosscheck.load_published_spearman(paths["proteingym_zero_shot_spearman"], proteingym_columns)
    model_rows = crosscheck.model_correlations(df, ratios, published)
    (PIPELINE_DIR / "crosscheck-report.md").write_text(crosscheck.report_markdown(result, reconciliation, model_rows))
    log(f"  Spearman {result['spearman']:.5f}, overlap {result['overlap']:,}")
    for row in model_rows:
        log(f"  {row['model']}: rho {row['spearmanAll']:.3f} (ProteinGym {row['proteingymPublished']})")

    log("stage 4: encode artifacts")
    models = {
        "esm": (
            esm_matrix,
            {
                "label": "ESM-2",
                "model": args.esm_model,
                "method": args.esm_method,
                "spearman": round(model_rows[0]["spearmanAll"], 4),
            },
        ),
        "profile": (
            profile_matrix,
            {
                "label": "Evolutionary profile",
                "model": "site-independent profile of ProteinGym's GFP_AEQVI MSA",
                "method": f"weighted frequencies, theta {profile_meta['theta']}, pseudocount {profile_meta['pseudocount']}",
                "spearman": round(model_rows[-1]["spearmanAll"], 4),
                "msa": profile_meta,
            },
        ),
    }
    index = encode.write_artifacts(ARTIFACTS_DIR, df, models, ref, summary)
    shutil.copyfile(paths["alphafold_p42212"], ARTIFACTS_DIR / ref["structure"]["file"])
    log(f"  variants.bin {index['byteLength']:,} bytes, {index['variantCount']:,} variants")

    log(f"stage 5: offline bake-off ({args.seeds} seeds)")
    land = bakeoff.build_landscape(df, {"esm": esm_matrix, "profile": profile_matrix}, wild_type)
    chosen = bakeoff.Config()
    results = bakeoff.bakeoff(land, chosen, range(args.seeds))
    chosen_summary = bakeoff.summarize(results)
    sweep = bakeoff.grid(land, range(args.seeds))
    (PIPELINE_DIR / "bakeoff-report.md").write_text(
        bakeoff.report_markdown(chosen, chosen_summary, sweep, args.seeds)
    )
    for r in chosen_summary.to_dict("records"):
        log(f"  {r['strategy']:>12}: best {r['finalBest']:.3f}, hit rate {r['hitRate']:.1%}, dark {r['dark']:.1f}")

    log("stage 6: provenance")
    encode.write_provenance(
        ARTIFACTS_DIR,
        download.load_manifest(RAW_DIR),
        {
            "pipelineVersion": PIPELINE_VERSION,
            "primarySource": "Sarkisyan et al. 2016, Local fitness landscape of the green fluorescent protein, "
            "Nature 533:397-401, doi:10.1038/nature17995",
            "positionOffset": POSITION_OFFSET,
            "positionNumbering": "avGFP / UniProt P42212, 1-based, initiator Met = 1",
            "construct": "P42212 with F64L (translated from the figshare reference DNA; asserted by the pipeline)",
            "brightnessScale": "log10 median brightness; > %s is visibly fluorescent" % VISIBLE_THRESHOLD,
            "aaOrder": AA_ORDER,
            "models": {k: v[1] for k, v in models.items()},
            "crosscheck": {
                "against": "ProteinGym GFP_AEQVI_Sarkisyan_2016",
                "spearman": round(result["spearman"], 6),
                "overlap": result["overlap"],
                "proteingymCoveredByLocal": result["proteingymCoveredByLocal"],
                "summaryStatisticReconciled": reconciliation["beyondTolerance"] == 0,
            },
            "esmArgmaxAgreement": round(agreement, 4),
        },
    )
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
