"""Reference sequence and per-residue annotations.

Two sequences matter:

* UniProt P42212 -- canonical wild-type avGFP.
* The construct Sarkisyan et al. actually mutagenised, translated from the
  figshare reference DNA. It carries F64L relative to P42212 (ProteinGym's
  target_seq agrees). Mutation wild-type letters in the TSV refer to the
  construct, so the offset assertion in clean.py validates against it.

build_reference() asserts the two differ at exactly EXPECTED_CONSTRUCT_DIFFERENCES,
so a surprise in either source stops the pipeline.
"""

from __future__ import annotations

import itertools
from pathlib import Path

import numpy as np

from .constants import CHROMOPHORE, EXPECTED_CONSTRUCT_DIFFERENCES, SEQ_LEN

_BASES = "TCAG"
_CODON_AA = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"
CODON_TABLE = {"".join(c): _CODON_AA[i] for i, c in enumerate(itertools.product(_BASES, repeat=3))}

# Half-sphere exposure: neighbours counted in the hemisphere a side chain points into.
HSE_RADIUS = 13.0
BURIED_HSE_UP = 20


class ConstructMismatchError(AssertionError):
    pass


def read_fasta(path: Path) -> str:
    return "".join(line.strip() for line in path.read_text().splitlines() if not line.startswith(">"))


def translate(dna: str) -> str:
    dna = dna.upper()
    if len(dna) % 3:
        raise ValueError(f"DNA length {len(dna)} is not a multiple of 3")
    return "".join(CODON_TABLE[dna[i : i + 3]] for i in range(0, len(dna), 3))


def construct_from_dna(dna: str) -> str:
    """The figshare DNA starts after the ATG and ends with a stop codon."""
    protein = translate(dna)
    if not protein.endswith("*") or "*" in protein[:-1]:
        raise ValueError("reference DNA should contain exactly one, terminal, stop codon")
    return "M" + protein[:-1]


def sequence_differences(a: str, b: str) -> dict[int, tuple[str, str]]:
    if len(a) != len(b):
        raise ConstructMismatchError(f"length {len(a)} != {len(b)}")
    return {i + 1: (x, y) for i, (x, y) in enumerate(zip(a, b)) if x != y}


def check_construct(uniprot: str, construct: str) -> None:
    diffs = sequence_differences(uniprot, construct)
    if diffs != EXPECTED_CONSTRUCT_DIFFERENCES:
        raise ConstructMismatchError(
            f"construct vs P42212 differences {diffs} != expected {EXPECTED_CONSTRUCT_DIFFERENCES}"
        )


def parse_pdb_backbone(pdb_text: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, str]:
    """Return (ca, cb, plddt, sequence) per residue, 1 row per residue in order.

    Glycine has no CB; a virtual CB is placed from the backbone geometry."""
    three_to_one = {
        "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C", "GLN": "Q", "GLU": "E",
        "GLY": "G", "HIS": "H", "ILE": "I", "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F",
        "PRO": "P", "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
    }  # fmt: skip
    residues: dict[int, dict] = {}
    for line in pdb_text.splitlines():
        if not line.startswith("ATOM"):
            continue
        atom = line[12:16].strip()
        resnum = int(line[22:26])
        res = residues.setdefault(resnum, {"name": line[17:20], "plddt": float(line[60:66])})
        res[atom] = np.array([float(line[30:38]), float(line[38:46]), float(line[46:54])])

    order = sorted(residues)
    ca, cb = [], []
    for r in order:
        res = residues[r]
        if "CB" in res:
            cb.append(res["CB"])
        else:  # ideal virtual CB (Engh & Huber geometry)
            b = res["CA"] - res["N"]
            c = res["C"] - res["CA"]
            a = np.cross(b, c)
            cb.append(-0.58273431 * a + 0.56802827 * b - 0.54067466 * c + res["CA"])
        ca.append(res["CA"])
    seq = "".join(three_to_one[residues[r]["name"]] for r in order)
    plddt = np.array([residues[r]["plddt"] for r in order])
    return np.array(ca), np.array(cb), plddt, seq


def half_sphere_exposure_up(ca: np.ndarray, cb: np.ndarray, radius: float = HSE_RADIUS) -> np.ndarray:
    """Count CA atoms within `radius` of each CA on the side-chain side.

    High values mean the side chain points into the protein. This
    distinguishes inward- from outward-facing residues on a beta-barrel
    strand, which a plain neighbour count cannot."""
    up = cb - ca
    up /= np.linalg.norm(up, axis=1, keepdims=True)
    delta = ca[None, :, :] - ca[:, None, :]  # [i, j] = CA_j - CA_i
    dist = np.linalg.norm(delta, axis=2)
    near = (dist < radius) & (dist > 0)
    above = np.einsum("ijk,ik->ij", delta, up) > 0
    return (near & above).sum(axis=1)


def build_reference(uniprot_fasta: Path, construct_fa: Path, alphafold_pdb: Path) -> dict:
    uniprot = read_fasta(uniprot_fasta)
    construct = construct_from_dna(read_fasta(construct_fa))
    if len(uniprot) != SEQ_LEN:
        raise ConstructMismatchError(f"P42212 length {len(uniprot)} != {SEQ_LEN}")
    check_construct(uniprot, construct)

    ca, cb, plddt, af_seq = parse_pdb_backbone(alphafold_pdb.read_text())
    if af_seq != uniprot:
        raise ConstructMismatchError("AlphaFold model sequence does not match P42212")
    hse = half_sphere_exposure_up(ca, cb)

    return {
        "uniprotId": "P42212",
        "name": "Green fluorescent protein (avGFP), Aequorea victoria",
        "length": SEQ_LEN,
        "sequence": construct,
        "uniprotSequence": uniprot,
        "constructDifferences": [
            {"position": pos, "uniprot": u, "construct": c}
            for pos, (u, c) in sorted(sequence_differences(uniprot, construct).items())
        ],
        "chromophore": {"start": CHROMOPHORE[0], "end": CHROMOPHORE[1], "residues": "SYG"},
        "structure": {
            "file": "AF-P42212-F1-model_v6.pdb",
            "source": "AlphaFold DB AF-P42212-F1 v6 (models P42212, i.e. F64; the construct has L64)",
        },
        "burial": {
            "method": f"half-sphere exposure (HSE-up, CA within {HSE_RADIUS} A) on the AlphaFold model; "
            f"buried if HSE-up >= {BURIED_HSE_UP}",
            "hseUp": hse.astype(int).tolist(),
            "buried": (hse >= BURIED_HSE_UP).tolist(),
        },
        "plddt": np.round(plddt, 1).tolist(),
    }
