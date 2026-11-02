import pandas as pd
import pytest

from glowfinder_pipeline.constants import AA_ORDER, SEQ_LEN
from glowfinder_pipeline.encode import (
    decode_mutation,
    decode_variants,
    encode_mutation,
    encode_variants,
    runtime_table,
)


def test_codec_formula_and_edges():
    assert encode_mutation(1, "A") == 0
    assert encode_mutation(1, "Y") == 19
    assert encode_mutation(2, "A") == 20
    assert encode_mutation(SEQ_LEN, "Y") == SEQ_LEN * 20 - 1
    assert SEQ_LEN * 20 - 1 < 0xFFFF  # fits uint16


@pytest.mark.parametrize("position", range(1, SEQ_LEN + 1, 17))
def test_codec_round_trip(position):
    for aa in AA_ORDER:
        assert decode_mutation(encode_mutation(position, aa)) == (position, aa)


@pytest.mark.parametrize("position", [0, SEQ_LEN + 1])
def test_codec_rejects_out_of_range(position):
    with pytest.raises(ValueError):
        encode_mutation(position, "A")


def toy_clean_df():
    rows = [
        ((), 3.719, False),
        ((("K", 3, "R"),), 3.6, True),
        ((("K", 3, "R"), ("E", 5, "D")), 1.2834, True),
        ((("S", 2, "A"), ("K", 3, "R"), ("G", 4, "W")), 4.1231, False),
        ((("S", 2, "*"),), 1.3, False),  # stop codon: not shipped
    ]
    return pd.DataFrame(
        {
            "mutations": [r[0] for r in rows],
            "mutation_str": [":".join(f"{w}{p}{m}" for w, p, m in r[0]) for r in rows],
            "n_mut": [len(r[0]) for r in rows],
            "median_log_brightness": [r[1] for r in rows],
            "low_confidence": [r[2] for r in rows],
            "has_stop": [any(m[2] == "*" for m in r[0]) for r in rows],
        }
    )


def test_encode_decode_round_trip():
    table = runtime_table(toy_clean_df())
    blob, meta = encode_variants(table)
    decoded = decode_variants(blob, meta["quantization"]["min"])

    assert len(decoded) == 4  # stop codon dropped
    assert decoded[0]["codes"] == ()  # wild type first
    for row, out in zip(table.itertuples(), decoded):
        assert out["codes"] == row.codes
        assert out["lowConfidence"] == row.low_confidence
        assert abs(out["brightness"] - row.median_log_brightness) <= 0.0005 + 1e-9


def test_codes_are_sorted_within_a_variant():
    table = runtime_table(toy_clean_df())
    for codes in table["codes"]:
        assert list(codes) == sorted(codes)


def test_decode_rejects_trailing_bytes_and_bad_magic():
    table = runtime_table(toy_clean_df())
    blob, meta = encode_variants(table)
    with pytest.raises(ValueError, match="trailing"):
        decode_variants(blob + b"\0", meta["quantization"]["min"])
    with pytest.raises(ValueError, match="glowfinder"):
        decode_variants(b"NOPE" + blob[4:], meta["quantization"]["min"])
