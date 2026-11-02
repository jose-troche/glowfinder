"""Runs the real ESM-2 8M checkpoint (downloads ~30 MB on first run).

Deselect with `pytest -m "not slow"`."""

import pytest

from glowfinder_pipeline.constants import ARTIFACTS_DIR
from glowfinder_pipeline.esm_score import SMALL_MODEL, argmax_agreement, masked_marginal_log_probs, wild_type_log_probs

pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def wild_type():
    import json

    path = ARTIFACTS_DIR / "reference.json"
    if not path.exists():
        pytest.skip("reference.json not built")
    return json.loads(path.read_text())["sequence"]


def test_unmasked_argmax_matches_wild_type(wild_type):
    """If BOS/EOS stripping were off by one, rows would be shifted and agreement would collapse."""
    m = wild_type_log_probs(wild_type, SMALL_MODEL)
    assert m.shape == (238, 20)
    assert argmax_agreement(m, wild_type) > 0.95
    # and specifically at the chromophore
    assert argmax_agreement(m[64:67], wild_type[64:67]) == 1.0


def test_masked_marginals_shape_and_normalisation(wild_type):
    import numpy as np

    m = masked_marginal_log_probs(wild_type[:40], SMALL_MODEL)
    assert m.shape == (40, 20)
    # 20 amino acids carry nearly all the mass (the rest is special/rare tokens)
    assert np.all(np.exp(m).sum(axis=1) > 0.9)
