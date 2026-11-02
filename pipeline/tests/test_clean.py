import pandas as pd
import pytest

from glowfinder_pipeline.clean import (
    OffsetMismatchError,
    clean,
    mutation_string,
    parse_genotype,
    summarize,
)

# A toy wild type: position 1 = M, 2 = S, 3 = K, 4 = G, 5 = E, ...
WT = "MSKGEELFTG"


def test_offset_maps_file_numbering_to_avgfp():
    # File position 0 is S2; +2 gives avGFP numbering.
    assert parse_genotype("SS0A", WT) == (("S", 2, "A"),)
    assert parse_genotype("SK1R:SE3D", WT) == (("K", 3, "R"), ("E", 5, "D"))


@pytest.mark.parametrize("offset", [0, 1, 3])
def test_offset_assertion_fires_on_wrong_offset(offset):
    with pytest.raises(OffsetMismatchError):
        parse_genotype("SK1R:SE3D", WT, offset=offset)


def test_offset_assertion_fires_on_corrupted_wild_type_letter():
    with pytest.raises(OffsetMismatchError, match="Offset mismatch at 3"):
        parse_genotype("SA1R", WT)  # position 3 is K, not A


def test_out_of_range_position_fails_loudly():
    with pytest.raises(OffsetMismatchError, match="out of range"):
        parse_genotype("SK99R", WT)


def test_wild_type_row_is_empty():
    assert parse_genotype("", WT) == ()


def test_mutations_sorted_by_position():
    assert parse_genotype("SE3D:SK1R", WT) == (("K", 3, "R"), ("E", 5, "D"))


@pytest.mark.parametrize("bad", ["K1R", "SK1", "SKxR", "SK1R:"])
def test_unparseable_tokens_raise(bad):
    with pytest.raises(ValueError):
        parse_genotype(bad, WT)


def test_duplicate_positions_raise():
    with pytest.raises(ValueError, match="duplicate position"):
        parse_genotype("SK1R:SK1D", WT)


def test_mutation_string_is_proteingym_style():
    assert mutation_string((("K", 3, "R"), ("E", 5, "D"))) == "K3R:E5D"


def write_tsv(tmp_path, rows):
    path = tmp_path / "toy.tsv"
    pd.DataFrame(rows, columns=["aaMutations", "uniqueBarcodes", "medianBrightness", "std"]).to_csv(
        path, sep="\t", index=False
    )
    return path


def test_clean_flags_low_confidence_and_stop_codons(tmp_path):
    path = write_tsv(
        tmp_path,
        [
            ["", 100, 3.7, 0.1],
            ["SK1R", 1, 3.6, None],
            ["SE3D:SL5P", 4, 1.3, 0.2],
            ["SG2*", 2, 1.29, 0.1],
        ],
    )
    df = clean(path, WT)
    assert df["low_confidence"].tolist() == [False, True, False, False]
    assert df["has_stop"].tolist() == [False, False, False, True]
    assert df["visible"].tolist() == [True, True, False, False]
    s = summarize(df)
    assert s["variantsShipped"] == 3
    assert s["withStopCodon"] == 1
    assert s["wildTypeLogBrightness"] == 3.7


def test_clean_rejects_missing_wild_type(tmp_path):
    path = write_tsv(tmp_path, [["SK1R", 1, 3.6, None]])
    with pytest.raises(ValueError, match="wild-type"):
        clean(path, WT)
