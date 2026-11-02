import numpy as np
import pytest

from glowfinder_pipeline.constants import AA_INDEX, AA_ORDER
from glowfinder_pipeline.esm_score import (
    SpecialTokenError,
    argmax_agreement,
    extract_residue_log_probs,
    log_ratio_matrix,
    score_variant,
)
from glowfinder_pipeline.evolution import focus_columns, read_a2m, sequence_weights


class FakeTokenizer:
    """Mimics the ESM tokenizer layout: <cls>=0, <eos>=2, residues from 4 in AA_ORDER."""

    cls_token_id = 0
    eos_token_id = 2

    def convert_ids_to_tokens(self, i):
        return {0: "<cls>", 2: "<eos>"}.get(i, AA_ORDER[i - 4] if i >= 4 else "<pad>")

    def convert_tokens_to_ids(self, aa):
        return AA_INDEX[aa] + 4

    def ids(self, seq):
        return [0, *[AA_INDEX[a] + 4 for a in seq], 2]


def test_extract_strips_special_tokens_and_reorders_columns():
    tok = FakeTokenizer()
    seq = "MKV"
    ids = tok.ids(seq)
    log_probs = np.random.default_rng(0).normal(size=(len(ids), 24))
    out = extract_residue_log_probs(log_probs, ids, tok, seq)
    assert out.shape == (3, 20)
    # row 0 of the output is token 1 (M), column order is AA_ORDER
    assert out[0, AA_INDEX["K"]] == pytest.approx(log_probs[1, AA_INDEX["K"] + 4])


def test_extract_detects_off_by_one():
    tok = FakeTokenizer()
    ids = tok.ids("MKV")
    shifted = [ids[0], ids[2], ids[3], ids[1], ids[4]]  # residues rotated by one
    with pytest.raises(SpecialTokenError):
        extract_residue_log_probs(np.zeros((5, 24)), shifted, tok, "MKV")


def test_extract_requires_cls_and_eos():
    tok = FakeTokenizer()
    ids = tok.ids("MKV")[1:] + [2]
    with pytest.raises(SpecialTokenError):
        extract_residue_log_probs(np.zeros((5, 24)), ids, tok, "MKV")


def test_log_ratio_is_zero_for_wild_type_and_additive():
    seq = "MKV"
    matrix = np.log(np.full((3, 20), 1 / 20))
    matrix[1, AA_INDEX["R"]] = np.log(0.5)
    matrix[1, AA_INDEX["K"]] = np.log(0.25)
    ratios = log_ratio_matrix(matrix, seq)
    for i, aa in enumerate(seq):
        assert ratios[i, AA_INDEX[aa]] == 0
    assert score_variant(ratios, [("K", 2, "R")]) == pytest.approx(np.log(2))
    both = score_variant(ratios, [("K", 2, "R"), ("V", 3, "A")])
    assert both == pytest.approx(score_variant(ratios, [("K", 2, "R")]) + score_variant(ratios, [("V", 3, "A")]))


def test_argmax_agreement():
    seq = "MK"
    m = np.zeros((2, 20))
    m[0, AA_INDEX["M"]] = 1
    m[1, AA_INDEX["A"]] = 1
    assert argmax_agreement(m, seq) == 0.5


A2M = """>query/1-6
mSKGEl
>hom1/1-4
.SRGE.
>hom2/1-6
.SKG-.
"""


def test_a2m_focus_columns_use_uppercase_query_positions():
    records = read_a2m(A2M)
    aln, positions = focus_columns(records, "MSKGEL")
    assert positions == [2, 3, 4, 5]
    assert aln.tolist() == [list("SKGE"), list("SRGE"), list("SKG-")]


def test_a2m_query_must_match_construct():
    with pytest.raises(AssertionError):
        focus_columns(read_a2m(A2M), "MAKGEL")


def test_identical_sequences_share_weight():
    aln = np.array([list("AAAA"), list("AAAA"), list("CCCC")])
    w = sequence_weights(aln, theta=0.2)
    assert w.tolist() == [0.5, 0.5, 1.0]
