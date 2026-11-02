"""Fetch every raw input into data/raw/ and record what was fetched, when, and
its checksum in data/raw/manifest.json (later copied into provenance.json)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import requests

from .constants import RAW_DIR

USER_AGENT = "glowfinder-pipeline/1.0 (+https://github.com/jose-troche/glowfinder)"


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    filename: str
    md5: str | None = None  # published checksum, verified when known
    member: str | None = None  # when set, url is a zip and only this member is fetched (HTTP ranges)
    citation: str = ""
    license: str = ""


SOURCES = {
    s.name: s
    for s in [
        Source(
            name="sarkisyan_aa_genotypes",
            url="https://ndownloader.figshare.com/files/4820647",
            filename="amino_acid_genotypes_to_brightness.tsv",
            md5="bfff10393b2bedd687738885de79d76d",
            citation="Sarkisyan et al. 2016, Nature 533:397-401, doi:10.1038/nature17995; "
            "figshare doi:10.6084/m9.figshare.3102154.v1",
            license="CC BY 4.0",
        ),
        Source(
            name="sarkisyan_nt_genotypes",
            url="https://ndownloader.figshare.com/files/4820650",
            filename="nucleotide_genotypes_to_brightness.tsv",
            md5="a88421beea91b707174b9a76c359c3eb",
            citation="Sarkisyan et al. 2016; figshare doi:10.6084/m9.figshare.3102154.v1",
            license="CC BY 4.0",
        ),
        Source(
            name="sarkisyan_reference_dna",
            url="https://ndownloader.figshare.com/files/4820653",
            filename="avGFP_reference_sequence.fa",
            md5="c1af632d736837b1d1518cb9aae53859",
            citation="Sarkisyan et al. 2016; figshare doi:10.6084/m9.figshare.3102154.v1",
            license="CC BY 4.0",
        ),
        Source(
            name="uniprot_p42212",
            url="https://rest.uniprot.org/uniprotkb/P42212.fasta",
            filename="P42212.fasta",
            citation="UniProt Consortium, UniProtKB P42212 (GFP_AEQVI)",
            license="CC BY 4.0",
        ),
        Source(
            name="alphafold_p42212",
            url="https://alphafold.ebi.ac.uk/files/AF-P42212-F1-model_v6.pdb",
            filename="AF-P42212-F1-model_v6.pdb",
            citation="AlphaFold DB (Jumper et al. 2021; Varadi et al. 2024), AF-P42212-F1 v6",
            license="CC BY 4.0",
        ),
        Source(
            name="proteingym_gfp",
            url="https://huggingface.co/datasets/OATML-Markslab/ProteinGym/resolve/main/"
            "ProteinGym_substitutions/GFP_AEQVI_Sarkisyan_2016.csv",
            filename="GFP_AEQVI_Sarkisyan_2016.csv",
            citation="Notin et al. 2023, ProteinGym, NeurIPS Datasets and Benchmarks",
            license="MIT",
        ),
        Source(
            name="proteingym_gfp_msa",
            url="https://zenodo.org/api/records/15293562/files/DMS_msa_files.zip/content",
            member="DMS_msa_files/GFP_AEQVI_full_04-29-2022_b08.a2m",
            filename="GFP_AEQVI_full_04-29-2022_b08.a2m",
            citation="Notin et al. 2023, ProteinGym v1.3 MSA for GFP_AEQVI (Zenodo 10.5281/zenodo.15293562)",
            license="MIT",
        ),
        Source(
            name="proteingym_zero_shot_spearman",
            url="https://raw.githubusercontent.com/OATML-Markslab/ProteinGym/main/benchmarks/"
            "DMS_zero_shot/substitutions/Spearman/DMS_substitutions_Spearman_DMS_level.csv",
            filename="DMS_substitutions_Spearman_DMS_level.csv",
            citation="Notin et al. 2023, ProteinGym zero-shot substitution benchmark (per-assay Spearman)",
            license="MIT",
        ),
    ]
}

MANIFEST = "manifest.json"


def _digest(path: Path, algo: str) -> str:
    h = hashlib.new(algo)
    h.update(path.read_bytes())
    return h.hexdigest()


def fetch(name: str, raw_dir: Path = RAW_DIR, force: bool = False) -> Path:
    source = SOURCES[name]
    raw_dir.mkdir(parents=True, exist_ok=True)
    path = raw_dir / source.filename
    manifest = load_manifest(raw_dir)

    if force or not path.exists():
        if source.member:
            from .remote_zip import extract_member

            _, data = extract_member(source.url, source.member)
        else:
            resp = requests.get(source.url, headers={"User-Agent": USER_AGENT}, timeout=120)
            resp.raise_for_status()
            data = resp.content
        path.write_bytes(data)
        manifest[name] = {"retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    md5 = _digest(path, "md5")
    if source.md5 and md5 != source.md5:
        raise RuntimeError(f"{source.filename}: md5 {md5} does not match published {source.md5}")

    manifest.setdefault(name, {"retrieved_at": "unknown"})
    manifest[name].update(
        url=source.url,
        **({"member": source.member} if source.member else {}),
        filename=source.filename,
        md5=md5,
        sha256=_digest(path, "sha256"),
        citation=source.citation,
        license=source.license,
    )
    (raw_dir / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n")
    return path


def fetch_all(raw_dir: Path = RAW_DIR, force: bool = False) -> dict[str, Path]:
    return {name: fetch(name, raw_dir, force) for name in SOURCES}


def load_manifest(raw_dir: Path = RAW_DIR) -> dict:
    path = raw_dir / MANIFEST
    return json.loads(path.read_text()) if path.exists() else {}
