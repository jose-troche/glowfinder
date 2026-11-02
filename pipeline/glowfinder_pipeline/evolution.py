"""Site-independent evolutionary profile from GFP's own protein family.

Added after the M3 bake-off showed single-sequence ESM-2 has almost no
signal on this assay (Spearman 0.08-0.15, matching ProteinGym's published
numbers): GFP has few relatives in UniRef, so a language model trained on
UniRef has seen little that resembles it. A profile built from an
alignment of GFP homologs (ProteinGym's own MSA) does much better -- ProteinGym
reports 0.649 for its site-independent model.

Like the ESM matrix it is a 238 x 20 table of log-probabilities, additive
across substitutions, precomputed once, zero-shot (never sees the experiment).
"""

from __future__ import annotations

import numpy as np

from .constants import AA_INDEX, SEQ_LEN

THETA = 0.2  # sequences within 80% identity share one unit of weight
PSEUDOCOUNT = 1.0  # total pseudocount mass per column, spread uniformly over 20 aa
MAX_GAP_FRACTION = 0.5  # drop alignment rows that are mostly gaps in the focus columns


def read_a2m(text: str) -> list[tuple[str, str]]:
    records, name, seq = [], None, []
    for line in text.splitlines():
        if line.startswith(">"):
            if name is not None:
                records.append((name, "".join(seq)))
            name, seq = line[1:].strip(), []
        else:
            seq.append(line.strip())
    if name is not None:
        records.append((name, "".join(seq)))
    return records


def focus_columns(records: list[tuple[str, str]], wild_type: str) -> tuple[np.ndarray, list[int]]:
    """Align every row to the query's match (uppercase) columns.

    In a2m, lowercase letters and '.' are insertions relative to the query and
    are dropped. Returns (rows x focus columns array of letters, 1-based positions)."""
    query_name, query = records[0]
    pos = int(query_name.split("/")[1].split("-")[0])
    positions = []
    for ch in query:
        if ch == ".":
            continue
        if ch.isupper():
            if wild_type[pos - 1] != ch:
                raise AssertionError(f"MSA query has {ch} at {pos}, construct has {wild_type[pos - 1]}")
            positions.append(pos)
        pos += 1  # lowercase query letters are residues outside the focus columns

    rows = []
    for _, seq in records:
        match = [c for c in seq if c.isupper() or c == "-"]
        if len(match) != len(positions):
            raise ValueError("row length differs from query match columns")
        rows.append(match)
    return np.array(rows), positions


def sequence_weights(aln: np.ndarray, theta: float = THETA) -> np.ndarray:
    ids = np.array([[AA_INDEX.get(c, 20) for c in row] for row in aln])
    onehot = np.eye(21)[ids][:, :, :20].reshape(len(ids), -1)
    covered = (ids < 20).sum(axis=1)
    identity = (onehot @ onehot.T) / np.maximum(covered[:, None], 1)
    return 1.0 / (identity >= 1 - theta).sum(axis=1)


def profile_log_probs(a2m_text: str, wild_type: str) -> tuple[np.ndarray, dict]:
    """238 x 20 log-probabilities; positions outside the alignment are uniform (score 0)."""
    records = read_a2m(a2m_text)
    aln, positions = focus_columns(records, wild_type)
    gap_fraction = (aln == "-").mean(axis=1)
    aln = aln[gap_fraction <= MAX_GAP_FRACTION]
    weights = sequence_weights(aln)

    matrix = np.full((SEQ_LEN, 20), np.log(1 / 20), dtype=np.float64)
    for col, pos in enumerate(positions):
        counts = np.full(20, PSEUDOCOUNT / 20)
        for aa, w in zip(aln[:, col], weights):
            if aa in AA_INDEX:
                counts[AA_INDEX[aa]] += w
        matrix[pos - 1] = np.log(counts / counts.sum())
    meta = {
        "sequences": int(len(records)),
        "sequencesUsed": int(len(aln)),
        "effectiveSequences": round(float(weights.sum()), 2),
        "coveredPositions": [min(positions), max(positions)],
        "theta": THETA,
        "pseudocount": PSEUDOCOUNT,
    }
    return matrix.astype(np.float32), meta
