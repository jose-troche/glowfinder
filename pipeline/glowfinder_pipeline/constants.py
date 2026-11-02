"""Shared constants and paths. Anything the TypeScript runtime also needs is
written into the artifacts (variants.idx.json / reference.json) rather than
duplicated by hand on the other side."""

from pathlib import Path

PIPELINE_VERSION = "1.0.0"

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = REPO_ROOT / "data" / "raw"
BUILD_DIR = RAW_DIR / "build"  # intermediate files, gitignored
ARTIFACTS_DIR = REPO_ROOT / "data" / "artifacts"
PIPELINE_DIR = REPO_ROOT / "pipeline"

# Fixed amino-acid order for the mutation codec and the ESM matrix columns.
# Written into variants.idx.json and provenance.json; the runtime reads it from there.
AA_ORDER = "ACDEFGHIKLMNPQRSTVWY"
AA_INDEX = {aa: i for i, aa in enumerate(AA_ORDER)}

SEQ_LEN = 238

# The figshare TSV numbers residues from 0, starting at the residue after the
# initiator Met (S2 in avGFP numbering). Adding 2 gives avGFP numbering.
POSITION_OFFSET = 2

# medianBrightness is log10-scale. Above ~2.5 the protein is visibly fluorescent.
VISIBLE_THRESHOLD = 2.5

CHROMOPHORE = (65, 67)  # S65-Y66-G67, inclusive, 1-based

# Genotypes seen on fewer barcodes than this are flagged as low confidence.
MIN_BARCODES = 2

# The construct Sarkisyan et al. actually mutagenised differs from UniProt
# P42212 at exactly these positions. reference.py asserts this set exactly.
EXPECTED_CONSTRUCT_DIFFERENCES = {64: ("F", "L")}
