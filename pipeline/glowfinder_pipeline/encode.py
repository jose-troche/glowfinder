"""Stage 4: encode the variant table and ESM matrix as compact runtime artifacts.

Shared contract with src/data/codec.ts (enforced by testVectors, see
implementation §4.3):

    code = (position - 1) * 20 + aminoAcidIndex     # position 1-based, AA_ORDER index

variants.bin, little-endian:

    header (16 bytes): magic "GLOW", u16 version, u16 reserved,
                       u32 variantCount, u8 maxMutations, 3 bytes padding
    per variant:       u8 mutationCount, u16 codes[mutationCount] (ascending),
                       u16 quantizedBrightness = round((value - min) / scale),
                       u8 flags (bit 0: low confidence)

esm-matrix.bin, profile-matrix.bin: float32 little-endian, SEQ_LEN rows x 20
columns (AA_ORDER) of log-probabilities -- ESM-2 masked marginals and the
evolutionary profile respectively. Described in variants.idx.json "models".
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import struct
from pathlib import Path

import numpy as np
import pandas as pd

from .constants import AA_INDEX, AA_ORDER, SEQ_LEN, VISIBLE_THRESHOLD

MAGIC = b"GLOW"
FORMAT_VERSION = 1
HEADER = struct.Struct("<4sHHIB3x")
QUANT_SCALE = 0.001
FLAG_LOW_CONFIDENCE = 1


def encode_mutation(position: int, aa: str) -> int:
    if not 1 <= position <= SEQ_LEN:
        raise ValueError(f"position {position} out of range")
    return (position - 1) * 20 + AA_INDEX[aa]


def decode_mutation(code: int) -> tuple[int, str]:
    if not 0 <= code < SEQ_LEN * 20:
        raise ValueError(f"code {code} out of range")
    return code // 20 + 1, AA_ORDER[code % 20]


def variant_codes(mutations) -> tuple[int, ...]:
    return tuple(sorted(encode_mutation(pos, mut) for _, pos, mut in mutations))


def runtime_table(df: pd.DataFrame) -> pd.DataFrame:
    """Rows shipped to the browser: no stop codons, stable order (depth, then codes)."""
    shipped = df[~df["has_stop"]].copy()
    shipped["codes"] = [variant_codes(m) for m in shipped["mutations"]]
    shipped = shipped.sort_values(["n_mut", "codes"], kind="stable").reset_index(drop=True)
    return shipped


def quantization_min(values: pd.Series) -> float:
    return round(math.floor(values.min() / QUANT_SCALE) * QUANT_SCALE, 6)


def encode_variants(table: pd.DataFrame) -> tuple[bytes, dict]:
    qmin = quantization_min(table["median_log_brightness"])
    q = np.rint((table["median_log_brightness"].to_numpy() - qmin) / QUANT_SCALE).astype(np.int64)
    if q.min() < 0 or q.max() > 0xFFFF:
        raise ValueError("brightness does not fit uint16 at this scale")
    max_mut = int(table["n_mut"].max())

    out = bytearray(HEADER.pack(MAGIC, FORMAT_VERSION, 0, len(table), max_mut))
    for codes, qb, low in zip(table["codes"], q, table["low_confidence"]):
        out += struct.pack(f"<B{len(codes)}HHB", len(codes), *codes, int(qb), FLAG_LOW_CONFIDENCE if low else 0)

    meta = {"quantization": {"min": round(qmin, 6), "scale": QUANT_SCALE}, "maxMutations": max_mut}
    return bytes(out), meta


def decode_variants(buf: bytes, qmin: float, scale: float = QUANT_SCALE) -> list[dict]:
    magic, version, _, count, _ = HEADER.unpack_from(buf, 0)
    if magic != MAGIC or version != FORMAT_VERSION:
        raise ValueError("not a glowfinder variants.bin (or wrong version)")
    offset = HEADER.size
    out = []
    for _ in range(count):
        n = buf[offset]
        codes = struct.unpack_from(f"<{n}H", buf, offset + 1)
        qb, flags = struct.unpack_from("<HB", buf, offset + 1 + 2 * n)
        out.append({"codes": codes, "brightness": qmin + qb * scale, "lowConfidence": bool(flags & FLAG_LOW_CONFIDENCE)})
        offset += 1 + 2 * n + 3
    if offset != len(buf):
        raise ValueError(f"{len(buf) - offset} trailing bytes")
    return out


def test_vectors(table: pd.DataFrame, qmin: float, seed: int = 2016) -> dict:
    """Known answers the TypeScript codec must reproduce exactly."""
    rng = random.Random(seed)
    singles = [m for muts in table["mutations"] for m in muts]
    unique = sorted(set(singles), key=lambda m: (m[1], m[2]))
    picked = rng.sample(unique, 46)
    # edges of the code space, whether or not the data contains them
    edges = [("M", 1, "A"), ("M", 1, "Y"), ("K", SEQ_LEN, "A"), ("K", SEQ_LEN, "Y")]
    mutations = [
        {"mutation": f"{w}{p}{m}", "position": p, "aa": m, "code": encode_mutation(p, m)}
        for w, p, m in sorted(edges + picked, key=lambda m: (m[1], m[2]))
    ]
    rows = sorted(rng.sample(range(len(table)), 20))
    variants = [
        {
            "index": i,
            "mutations": table.at[i, "mutation_str"],
            "codes": list(table.at[i, "codes"]),
            "brightness": round(qmin + round((table.at[i, "median_log_brightness"] - qmin) / QUANT_SCALE) * QUANT_SCALE, 6),
            "lowConfidence": bool(table.at[i, "low_confidence"]),
        }
        for i in [0, *rows]
    ]
    return {"mutations": mutations, "variants": variants}


def write_artifacts(
    out_dir: Path,
    clean_df: pd.DataFrame,
    models: dict[str, tuple[np.ndarray, dict]],
    reference: dict,
    summary: dict,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    table = runtime_table(clean_df)
    blob, meta = encode_variants(table)
    (out_dir / "variants.bin").write_bytes(blob)

    model_index = {}
    for name, (matrix, model_meta) in models.items():
        if matrix.shape != (SEQ_LEN, 20) or not np.isfinite(matrix).all():
            raise ValueError(f"{name} matrix shape {matrix.shape} or non-finite values")
        filename = f"{name}-matrix.bin"
        (out_dir / filename).write_bytes(matrix.astype("<f4").tobytes())
        model_index[name] = {
            "file": filename,
            "dtype": "float32",
            "shape": [SEQ_LEN, 20],
            "values": "log-probabilities, rows = positions 1..238, columns in aaOrder",
            **model_meta,
        }

    wt = float(table.loc[table["n_mut"] == 0, "median_log_brightness"].iloc[0])
    index = {
        "format": {"magic": MAGIC.decode(), "version": FORMAT_VERSION, "endianness": "little", "headerBytes": HEADER.size},
        "aaOrder": AA_ORDER,
        "sequenceLength": SEQ_LEN,
        "codec": "code = (position - 1) * 20 + aaOrder.indexOf(aa); position is 1-based",
        "variantCount": int(len(table)),
        "byteLength": len(blob),
        "maxMutations": meta["maxMutations"],
        "quantization": meta["quantization"],
        "flags": {"lowConfidence": FLAG_LOW_CONFIDENCE},
        "brightness": {
            "scale": "log10",
            "min": float(table["median_log_brightness"].min()),
            "max": float(table["median_log_brightness"].max()),
            "wildType": wt,
            "visibleThreshold": VISIBLE_THRESHOLD,
        },
        "depthCounts": {str(k): int(v) for k, v in table["n_mut"].value_counts().sort_index().items()},
        "models": model_index,
        "summary": summary,
        "testVectors": test_vectors(table, meta["quantization"]["min"]),
    }
    _write_json(out_dir / "variants.idx.json", index)
    _write_json(out_dir / "reference.json", reference)
    return index


def write_provenance(out_dir: Path, manifest: dict, extra: dict) -> None:
    checksums = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(out_dir.iterdir())
        if p.is_file() and p.name != "provenance.json"
    }
    _write_json(out_dir / "provenance.json", {**extra, "sources": manifest, "artifacts": checksums})


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=1) + "\n")
