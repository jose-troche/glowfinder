# glowfinder pipeline

Offline, run once, output committed. Turns the raw Sarkisyan et al. 2016 data into the static
artifacts the web app reads. Nothing here runs at serving time.

## Re-run from scratch

```sh
cd pipeline
uv sync
uv run glowfinder-pipeline            # all stages, ~1 minute on a laptop CPU
uv run pytest                         # includes ESM-2 8M checks; `-m "not slow"` skips them
```

Options: `--esm-model facebook/esm2_t6_8M_UR50D`, `--esm-method wild-type-marginal`,
`--compare-model <checkpoint>` (repeatable, report only), `--seeds 20`, `--force-download`.

## Stages

| Stage | Module | Output |
|---|---|---|
| 0. Download | `download.py` | `data/raw/*` + `data/raw/manifest.json` (URLs, dates, md5/sha256). Figshare md5s are verified against the published values. The ProteinGym MSA is pulled out of a 1.5 GB Zenodo zip with HTTP range requests (`remote_zip.py`). |
| 1. Reference | `reference.py` | Construct sequence, F64L check, burial from the AlphaFold model |
| 1. Clean | `clean.py` | Parsed, **+2 offset**, validated variant table; `landscape-summary.md` |
| 2. Models | `esm_score.py`, `evolution.py` | ESM-2 masked-marginal matrix; evolutionary profile matrix |
| 3. Cross-check | `crosscheck.py` | `crosscheck-report.md` (gates the pipeline) |
| 4. Encode | `encode.py` | `data/artifacts/*` |
| 5. Bake-off | `bakeoff.py` | `bakeoff-report.md` |
| 6. Provenance | `encode.py` | `data/artifacts/provenance.json` (sources, checksums) |

`notebooks/exploration.ipynb` is the narrative version of the same steps.

## The things that bite

- **+2 offset.** The TSV numbers residues from 0 starting at S2. `clean.parse_genotype` checks
  every wild-type letter against the reference and stops at the first mismatch.
- **The reference is not P42212.** The construct that was mutagenised carries **F64L**
  (translated from the figshare reference DNA; ProteinGym's `target_seq` agrees). Validating
  against UniProt P42212 directly fails at position 64. `reference.check_construct` asserts that
  F64L is the *only* difference.
- **Log scale.** `medianBrightness` is log10. The column is renamed `median_log_brightness` so
  nobody averages it as if linear.
- **"Low confidence" is most of the data.** 50,035 of 51,715 genotypes were seen on a single
  barcode. They are flagged, never dropped; dropping them would leave ~1,700 variants.
- **ProteinGym uses a different summary statistic.** Its `DMS_score` is the mean of
  per-nucleotide-genotype medians; the TSV is the median over all barcodes. 483 multi-barcode
  variants differ. `crosscheck.reconcile` rebuilds ProteinGym's statistic from the raw
  nucleotide TSV and matches it to 1e-14, so the difference is explained, not tolerated.
- **ESM-2 is weak on GFP.** See `bakeoff-report.md`. Our masked-marginal Spearman reproduces
  ProteinGym's published 0.131 (35M) and 0.078 (8M) exactly; GFP has few relatives in UniRef.
  This is why the app also races an evolutionary profile built from ProteinGym's GFP alignment.
