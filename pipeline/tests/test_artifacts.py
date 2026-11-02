"""Checks against the committed artifacts in data/artifacts/ -- what actually ships."""

import hashlib
import json

import numpy as np
import pytest

from glowfinder_pipeline.constants import ARTIFACTS_DIR, CHROMOPHORE, SEQ_LEN
from glowfinder_pipeline.encode import decode_mutation, decode_variants

pytestmark = pytest.mark.skipif(not (ARTIFACTS_DIR / "variants.bin").exists(), reason="artifacts not built")


@pytest.fixture(scope="module")
def index():
    return json.loads((ARTIFACTS_DIR / "variants.idx.json").read_text())


@pytest.fixture(scope="module")
def decoded(index):
    return decode_variants((ARTIFACTS_DIR / "variants.bin").read_bytes(), index["quantization"]["min"])


def test_variant_count_and_wild_type(index, decoded):
    assert len(decoded) == index["variantCount"] == 51715
    assert decoded[0]["codes"] == ()
    assert decoded[0]["brightness"] == pytest.approx(index["brightness"]["wildType"], abs=5e-4)


def test_test_vectors_match_the_binary(index, decoded):
    for v in index["testVectors"]["variants"]:
        row = decoded[v["index"]]
        assert list(row["codes"]) == v["codes"]
        assert row["brightness"] == pytest.approx(v["brightness"], abs=1e-9)
        names = [f"{p}{aa}" for p, aa in map(decode_mutation, row["codes"])]
        assert [m[1:] for m in v["mutations"].split(":") if m] == names
    for m in index["testVectors"]["mutations"]:
        assert decode_mutation(m["code"]) == (m["position"], m["aa"])


def test_model_matrices_are_log_probabilities(index):
    for model in index["models"].values():
        m = np.fromfile(ARTIFACTS_DIR / model["file"], dtype="<f4").reshape(SEQ_LEN, 20)
        assert np.all(m <= 0)
        assert np.allclose(np.exp(m).sum(axis=1), 1.0, atol=1e-3) or model["label"] == "ESM-2"


def test_reference_annotations():
    ref = json.loads((ARTIFACTS_DIR / "reference.json").read_text())
    assert len(ref["sequence"]) == SEQ_LEN
    assert ref["sequence"][63] == "L" and ref["uniprotSequence"][63] == "F"
    assert ref["sequence"][CHROMOPHORE[0] - 1 : CHROMOPHORE[1]] == "SYG"
    # the chromophore sits in the middle of the barrel: buried
    assert all(ref["burial"]["buried"][p - 1] for p in range(CHROMOPHORE[0], CHROMOPHORE[1] + 1))


def test_provenance_checksums_match_files():
    prov = json.loads((ARTIFACTS_DIR / "provenance.json").read_text())
    assert prov["artifacts"], "no checksums recorded"
    for name, digest in prov["artifacts"].items():
        assert hashlib.sha256((ARTIFACTS_DIR / name).read_bytes()).hexdigest() == digest, name
    assert prov["crosscheck"]["spearman"] > 0.999


def test_shipped_size_budget():
    import gzip

    total = sum(len(gzip.compress((ARTIFACTS_DIR / f).read_bytes())) for f in ("variants.bin", "variants.idx.json"))
    assert total < 1_000_000
