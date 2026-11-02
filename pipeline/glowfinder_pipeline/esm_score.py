"""Stage 2: ESM-2 zero-shot scores as a 238 x 20 matrix.

A variant's score is the sum over its substitutions of
log P(mutant) - log P(wild type) -- additive by construction, so it
deliberately ignores epistasis. Never one forward pass per variant.

Two ways to fill the matrix:

* wild-type marginals: one forward pass over the unmasked sequence. Cheapest,
  but the model sees the residue it is asked about and mostly copies it.
* masked marginals (Meier et al. 2021, the ProteinGym convention, default):
  one pass per position with that position masked, batched. 238 passes of a
  35M model take seconds on a laptop CPU.

On this assay the M3 bake-off found both carry almost no signal within a
mutation depth -- consistent with ProteinGym's published ESM-2 Spearman of
0.08-0.15 for GFP. See pipeline/bakeoff-report.md.
"""

from __future__ import annotations

import numpy as np

from .constants import AA_INDEX, AA_ORDER

DEFAULT_MODEL = "facebook/esm2_t12_35M_UR50D"
SMALL_MODEL = "facebook/esm2_t6_8M_UR50D"
SCORING_METHODS = ("masked-marginal", "wild-type-marginal")
BATCH = 16


class SpecialTokenError(AssertionError):
    pass


def _load(model_name: str):
    from transformers import AutoModelForMaskedLM, AutoTokenizer

    return AutoTokenizer.from_pretrained(model_name), AutoModelForMaskedLM.from_pretrained(model_name).eval()


def wild_type_log_probs(sequence: str, model_name: str = DEFAULT_MODEL) -> np.ndarray:
    """Return a (len(sequence), 20) float32 matrix of log P(aa | sequence), columns in AA_ORDER."""
    import torch

    tokenizer, model = _load(model_name)
    inputs = tokenizer(sequence, return_tensors="pt")
    with torch.no_grad():
        logits = model(**inputs).logits[0]  # (L + 2, vocab): <cls> ... <eos>
    log_probs = torch.log_softmax(logits, dim=-1).numpy()

    token_ids = inputs["input_ids"][0].tolist()
    return extract_residue_log_probs(log_probs, token_ids, tokenizer, sequence)


def masked_marginal_log_probs(sequence: str, model_name: str = DEFAULT_MODEL) -> np.ndarray:
    """Row i is log P(aa | sequence with position i masked), columns in AA_ORDER."""
    import torch

    tokenizer, model = _load(model_name)
    ids = tokenizer(sequence, return_tensors="pt")["input_ids"]
    token_ids = ids[0].tolist()
    # Same special-token and alignment checks as the unmasked path.
    extract_residue_log_probs(np.zeros((len(token_ids), len(tokenizer))), token_ids, tokenizer, sequence)

    columns = [tokenizer.convert_tokens_to_ids(aa) for aa in AA_ORDER]
    out = np.zeros((len(sequence), 20), dtype=np.float32)
    with torch.no_grad():
        for start in range(0, len(sequence), BATCH):
            positions = range(start, min(start + BATCH, len(sequence)))
            batch = ids.repeat(len(positions), 1)
            for row, i in enumerate(positions):
                batch[row, i + 1] = tokenizer.mask_token_id  # +1 skips <cls>
            log_probs = torch.log_softmax(model(input_ids=batch).logits, dim=-1)
            for row, i in enumerate(positions):
                out[i] = log_probs[row, i + 1, columns].numpy()
    return out


def score_matrix(sequence: str, model_name: str = DEFAULT_MODEL, method: str = "masked-marginal") -> np.ndarray:
    if method == "masked-marginal":
        return masked_marginal_log_probs(sequence, model_name)
    if method == "wild-type-marginal":
        return wild_type_log_probs(sequence, model_name)
    raise ValueError(f"unknown scoring method {method!r}")


def extract_residue_log_probs(log_probs: np.ndarray, token_ids: list[int], tokenizer, sequence: str) -> np.ndarray:
    """Strip the BOS/EOS positions and reorder vocab columns to AA_ORDER.

    An off-by-one here is the second most likely silent bug in the project,
    so check that each kept row's input token really is the residue at that
    position rather than trusting the tokenizer layout."""
    if len(token_ids) != len(sequence) + 2:
        raise SpecialTokenError(f"expected {len(sequence) + 2} tokens, got {len(token_ids)}")
    if token_ids[0] != tokenizer.cls_token_id or token_ids[-1] != tokenizer.eos_token_id:
        raise SpecialTokenError("expected <cls> first and <eos> last")
    residues = log_probs[1:-1]
    for i, aa in enumerate(sequence):
        if tokenizer.convert_ids_to_tokens(token_ids[i + 1]) != aa:
            raise SpecialTokenError(f"token at residue {i + 1} is not {aa}")
    columns = [tokenizer.convert_tokens_to_ids(aa) for aa in AA_ORDER]
    return residues[:, columns].astype(np.float32)


def argmax_agreement(matrix: np.ndarray, sequence: str) -> float:
    """Fraction of positions whose most likely residue is the wild-type residue.

    Unmasked ESM strongly copies its input, so this should be near 1.0. A low
    value means the rows are shifted relative to the sequence."""
    predicted = matrix.argmax(axis=1)
    return float(np.mean([AA_ORDER[p] == aa for p, aa in zip(predicted, sequence)]))


def log_ratio_matrix(matrix: np.ndarray, sequence: str) -> np.ndarray:
    """log P(mutant) - log P(wild type), per position and amino acid."""
    wt_cols = np.array([AA_INDEX[aa] for aa in sequence])
    return matrix - matrix[np.arange(len(sequence)), wt_cols][:, None]


def score_variant(ratios: np.ndarray, mutations) -> float:
    return float(sum(ratios[pos - 1, AA_INDEX[mut]] for _, pos, mut in mutations))
