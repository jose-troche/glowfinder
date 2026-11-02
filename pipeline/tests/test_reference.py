import numpy as np
import pytest

from glowfinder_pipeline.reference import (
    ConstructMismatchError,
    check_construct,
    construct_from_dna,
    half_sphere_exposure_up,
    sequence_differences,
    translate,
)


def test_translate_standard_code():
    assert translate("ATGTTTTGGTAA") == "MFW*"


def test_construct_prepends_met_and_strips_terminal_stop():
    assert construct_from_dna("AGCAAGTGA") == "MSK"


def test_construct_rejects_internal_stop():
    with pytest.raises(ValueError):
        construct_from_dna("AGCTGAAAGTGA")


def test_check_construct_accepts_exactly_f64l():
    uniprot = "A" * 63 + "F" + "A" * 174
    construct = "A" * 63 + "L" + "A" * 174
    check_construct(uniprot, construct)


@pytest.mark.parametrize(
    "construct",
    [
        "A" * 238,  # F64 missing from the expected set
        "A" * 63 + "L" + "A" * 173 + "C",  # an extra, unexpected difference
    ],
)
def test_check_construct_rejects_surprises(construct):
    uniprot = "A" * 63 + "F" + "A" * 174
    with pytest.raises(ConstructMismatchError):
        check_construct(uniprot, construct)


def test_sequence_differences_is_one_based():
    assert sequence_differences("MSK", "MAK") == {2: ("S", "A")}


def test_half_sphere_exposure_counts_only_the_side_chain_hemisphere():
    ca = np.array([[0.0, 0, 0], [0, 0, 5.0], [0, 0, -5.0], [0, 0, 20.0]])
    cb = ca + np.array([0.0, 0, 1.0])  # every side chain points +z
    hse = half_sphere_exposure_up(ca, cb, radius=13.0)
    # residue 0 sees residue 1 above it (z=5) but not 2 (below) or 3 (too far)
    assert hse[0] == 1
    assert hse[3] == 0
