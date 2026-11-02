# glowfinder — Specification

> Four strategies hunt for a brighter jellyfish protein. Only one knows where it's going.

---

## 1. Product summary

Green fluorescent protein (avGFP) from the jellyfish *Aequorea victoria* is the protein that made modern cell biology visible. In 2016, Sarkisyan et al. measured the actual fluorescence of tens of thousands of mutated versions of it — a rare case where we hold a real map of what works and what doesn't for an entire protein.

glowfinder treats that map as hidden ground truth and runs a competition.

Several strategies each get an identical budget of guesses. Round after round, each proposes mutations, trying to climb toward a brighter protein. After each round the real measurements are revealed and every guess is scored honestly. The user watches the strategies separate.

**The strategies:**

| Strategy | What it knows | Expected behavior |
|---|---|---|
| Random | Nothing | Flails. Most variants go dark. |
| Conservative | Substitution chemistry only (BLOSUM-style) | Slightly better than random |
| Protein language model | ESM-2 log-probabilities; has read millions of sequences, never this experiment | Climbs steadily |
| LLM reasoning | Claude/Workers AI reasoning about structure and chemistry | The interesting one — plausible arguments, mixed results |

**The payoff is two insights, delivered by watching rather than reading:**

1. Why domain-specific training beats general intelligence on a domain-specific task. The LLM argues beautifully and loses to a smaller model that has only ever seen protein sequences.
2. How brutally narrow the landscape is. The original paper found the fitness peak to be narrow, with most single-mutation derivatives showing reduced fluorescence and roughly half of four-mutation derivatives going completely dark, sharpened further by epistasis. Good paths are a thin ridge through an enormous dark space.

### Non-goals

- Not a protein design tool. Nobody should take a glowfinder output to a lab bench.
- Not a benchmark. ProteinGym already does that rigorously; glowfinder is an explainer with honest scoring.
- No model training. Everything is zero-shot or precomputed.

### Success criteria

- A visitor with no biology background understands why one strategy wins.
- Every number shown traces to a real measurement, never a simulation.
- Runs entirely on free tiers, with the LLM strategy optional and gated.

---

## 2. The central design decision

**Every proposed variant must exist in the measured dataset.**

This is the constraint that makes the whole project work, and it is worth stating before anything else because every other decision follows from it.

The alternative — letting strategies propose arbitrary mutations — means most proposals have no ground truth, so you'd have to score them with a model, and then you're grading predictions against predictions. That is a simulation wearing the costume of an experiment.

By restricting the search space to measured variants:

- Every guess gets a real, experimentally determined score.
- No model is needed at runtime for scoring.
- The comparison between strategies is honest at every round.
- The whole thing runs client-side with zero inference cost.

The cost is realism: a real directed-evolution campaign isn't restricted to a precomputed library. **Say this plainly in the UI.** Framed as "we're exploring a known map, and the strategies don't get to see it," the constraint becomes the premise rather than a limitation.

---

## 3. Data

### 3.1 Primary source

**Sarkisyan et al. 2016**, *Local fitness landscape of the green fluorescent protein*, Nature 533:397–401, doi:10.1038/nature17995.

Data on figshare, "Local fitness landscape of the green fluorescent protein" (article 3102154). The file we want is `amino_acid_genotypes_to_brightness.tsv`, with columns:

| Column | Meaning |
|---|---|
| `aaMutations` | List of amino acid mutations; empty for wild-type |
| `uniqueBarcodes` | Number of unique barcodes sharing this genotype |
| `medianBrightness` | Median log-brightness across those barcodes |
| `std` | Standard deviation; empty for single-barcode genotypes |

Roughly 50,000+ variants, each carrying 1–15 substitutions. A few megabytes. No database required.

> ⚠️ **Two gotchas that will silently corrupt everything if missed.**
>
> 1. **Indexing offset.** The file's mutation numbering needs a **+2 offset** to align with wild-type avGFP amino acid numbering. Get this wrong and every structural claim is wrong while every number still looks plausible.
> 2. **Brightness is log-scale, not linear.** Values above roughly **2.5** correspond to visibly fluorescent protein. Averaging raw values as if linear is a real mistake that produces confident nonsense.

### 3.2 Cross-check source

**ProteinGym**, assay `GFP_AEQVI_Sarkisyan_2016`, from the `OATML-Markslab/ProteinGym` HuggingFace dataset. Columns: `mutant`, `DMS_score` (higher = fitter), `DMS_score_bin` (1 = above fitness cutoff).

ProteinGym is used as **validation, not as the primary source**. Build the pipeline from the raw figshare TSV, then confirm the numbers match ProteinGym's cleaned version. Agreement means the pipeline is right; disagreement means there's a bug worth chasing, and chasing it is the most educational hour in the project.

### 3.3 Reference sequence and structure

- avGFP: UniProt **P42212** (`GFP_AEQVI`), 238 aa.
- Structure for the 3D view: AlphaFold `AF-P42212-F1`, or a PDB experimental structure.
- The chromophore sits at residues 65–67 and is the single most important region to highlight.

### 3.4 Licensing

**Resolved: shipping derived data files is permitted, with attribution.** Checked 2026-11-02:

| Source | Where checked | License | Effect on glowfinder |
|---|---|---|---|
| Sarkisyan figshare deposit (article 3102154, doi:10.6084/m9.figshare.3102154.v1) | figshare API, `GET /v2/articles/3102154` → `license` field | **CC BY 4.0** | Redistributing derived files (`variants.bin` etc.) is allowed, commercial use included, as long as the work is credited and changes are noted |
| ProteinGym code | `LICENSE` and README "License" section in `OATML-Markslab/ProteinGym` on GitHub | **MIT** | No restriction |
| ProteinGym data release (Zenodo record 15293562, v1.3) | Zenodo API → `metadata.license` | **MIT** | No restriction. Only used for the Stage 3 cross-check anyway, and never shipped |
| ProteinGym HuggingFace dataset card | `OATML-Markslab/ProteinGym` README | None stated; it only asks users to cite the paper | Covered by the Zenodo/GitHub MIT terms |

The CC-BY-NC-ND 4.0 license previously flagged applies to the ProteinGym *paper* text only, not to the code or data, so it does not affect us.

UniProt (P42212 sequence) and AlphaFold DB (`AF-P42212-F1`) are both CC BY 4.0 according to their published terms. Their APIs don't return a license field, so this was not checked programmatically.

**Obligations:** credit every source in the README, in the app and in `provenance.json` (see §13), and state that the shipped files are derived from the figshare deposit (re-indexed, filtered and quantized). No fetch-script fallback is needed.

---

## 4. Architecture

```
┌─ OFFLINE (once, Python, laptop or Colab) ──────────────┐
│  figshare TSV ─┐                                        │
│                ├─► clean, +2 offset, filter ─► artifacts│
│  ESM-2 (8M/35M)┘   single forward pass                  │
│                                                          │
│  ProteinGym ──────► cross-check (not shipped)           │
└──────────────────────────┬──────────────────────────────┘
                           │  committed to repo
                           ▼
┌─ RUNTIME (Cloudflare Workers, free) ───────────────────┐
│  Static assets: artifacts + app bundle                  │
│                                                          │
│  Browser: simulation engine (TypeScript)                │
│    · random · conservative · ESM strategies run here    │
│    · zero server cost                                   │
│                                                          │
│  Worker: POST /api/llm-move  (LLM strategy only)        │
│    · rate limit per IP                                   │
│    · Turnstile                                           │
│    · Workers AI                                          │
└──────────────────────────────────────────────────────────┘
```

**The key architectural move: three of the four strategies need no server at all.** The ground-truth lookup and the ESM score matrix are static files; the simulation is arithmetic. A visitor can run the entire core experiment with the Worker doing nothing but serving files. Only the LLM strategy touches compute, and it is explicitly optional.

This makes the free tier almost irrelevant to the core experience, which is the right place to be.

---

## 5. Offline pipeline

Python, run once, output committed. Lives in `pipeline/` and is reproducible from a single command.

### Stage 1 — Clean the measurements

1. Download `amino_acid_genotypes_to_brightness.tsv` from figshare.
2. Parse `aaMutations` into structured `(wildTypeAA, position, mutantAA)` tuples.
3. **Apply the +2 position offset.**
4. Validate: every parsed wild-type residue must match the actual P42212 sequence at that position. **Any mismatch is a hard failure, not a warning.** This single assertion catches the offset bug, and it is the most valuable line in the pipeline.
5. Filter low-confidence genotypes (e.g. `uniqueBarcodes < 2`) into a flagged set rather than deleting them; the noise is part of the story.
6. Emit the variant table.

### Stage 2 — ESM-2 scoring

The insight that makes this cheap: **one forward pass, not 50,000.**

To score every possible single substitution, run the wild-type sequence through ESM-2 once and read the log-probabilities at each position. That yields a 238 × 20 matrix — about 4,760 floats, well under 100KB as JSON.

- `facebook/esm2_t6_8M_UR50D` (~30MB) runs on a laptop CPU in well under a second.
- `facebook/esm2_t12_35M_UR50D` (~150MB) is still comfortable and noticeably better.
- The 650M model (~2.5GB) wants a GPU and is almost certainly unnecessary here.

For multi-mutation variants, score as the sum of per-position log-ratios (`log P(mutant) − log P(wildtype)`). This ignores epistasis, which is exactly the point — the paper found epistasis in up to 30% of multi-mutant genotypes, so watching an additive model fail on deep mutants is itself a result worth surfacing.

Emit both the full matrix and precomputed scores for every variant in the measured set.

### Stage 3 — Cross-check

Load ProteinGym's `GFP_AEQVI_Sarkisyan_2016` and compare, variant by variant, to the locally derived table. Report coverage overlap and Spearman correlation of the scores. **Target: near-perfect agreement.** Anything else is a bug.

This stage's output goes in the README, not in the app. "I rebuilt the dataset from raw and it matches the published benchmark at ρ = 0.99" is the sentence that makes a technical reader trust everything else.

### Stage 4 — Encode for the web

Convert to a compact runtime format (see §6).

---

## 6. Runtime data format

A naive JSON dump of 50,000 variants is several megabytes and slow to parse on mobile. Three decisions fix it:

1. **Integer-encode mutations.** A substitution is `(position - 1) × 20 + aminoAcidIndex`, a single integer (position is 1-based; see `docs/implementation.md` §3.4, which is the authoritative definition). A variant is a short array of those.
2. **Quantize brightness.** Log-brightness fits comfortably in a `uint16` at 0.001 precision over the observed range. The measurement noise is far larger than the quantization error.
3. **Ship binary, not JSON.** A packed `ArrayBuffer` loaded with `fetch().then(r => r.arrayBuffer())` parses in a fraction of the time and compresses well over the wire.

Target: **under 1MB gzipped** for the full variant set.

Artifacts shipped as static assets:

| File | Contents |
|---|---|
| `variants.bin` | Packed variant table: mutation codes + quantized brightness |
| `variants.idx.json` | Index metadata: counts, offsets, value ranges |
| `esm-matrix.bin` | 238 × 20 log-probability matrix |
| `reference.json` | P42212 sequence, chromophore span, key annotated positions |
| `provenance.json` | Source DOIs, retrieval dates, pipeline version, checksums |

`provenance.json` is not optional. It is what lets someone audit the chain from published paper to pixel.

---

## 7. Simulation model

### Setup

- **Start:** wild-type avGFP.
- **Round:** each strategy proposes *N* candidate variants (default 5) from the measured set, not previously tried by that strategy.
- **Reveal:** real measured brightness for each proposal.
- **Selection:** the brightest proposal becomes that strategy's new reference point for the next round.
- **Budget:** fixed total proposals per strategy (default 50, i.e. 10 rounds).
- **Neighborhood:** proposals must be within a configured mutational distance of the strategy's current best, so it is a climb rather than a lottery.

### Strategy definitions

**Random.** Uniform sample from the eligible neighborhood. The control.

**Conservative.** Weighted toward chemically similar substitutions via a BLOSUM62-derived score. Represents classical, pre-ML intuition.

**ESM-2.** Ranks the eligible neighborhood by summed log-ratio from the precomputed matrix, takes the top *N*. Zero-shot — the model has never seen this experiment.

**LLM.** Sent the current variant, the eligible candidate list, structural context (chromophore position, buried vs. surface, domain annotations), and the history of what it has already tried with results. Asked to choose *N* candidates **and explain its reasoning**. The explanation is displayed; it is half the value of the strategy.

> ⚠️ **The LLM must never see the brightness values of untried candidates.** It can see its own history of tried variants and their revealed results — that's legitimate feedback. Leaking the ground truth of untried candidates turns the whole thing into theater. This is the easiest way to accidentally fake the result and the hardest to notice afterward.

### Scoring and display

- Live line chart: best-brightness-so-far per strategy, per round.
- Hit rate: proportion of proposals above the ~2.5 visible-fluorescence threshold.
- A "dark variants" counter — the number of proposals that killed the protein. This communicates landscape narrowness better than any chart.
- The 3D structure highlights mutated positions as they're tried, colored by outcome.
- Final scoreboard with a one-line verdict per strategy.

### Determinism

Seeded RNG, seed shown in the UI and included in shareable URLs. A reader must be able to reproduce a run exactly. Non-reproducible demos of stochastic processes are not evidence of anything.

---

## 8. Free-tier budget

| Resource | Free limit | glowfinder usage |
|---|---|---|
| Worker requests | 100,000 / day | Static asset serving; comfortable |
| Worker CPU | 10ms per invocation | Simulation runs in the browser — not a concern |
| KV writes | 1,000 / day | **Not used.** No KV in this project |
| Workers AI | 10,000 Neurons / day | LLM strategy only |
| Turnstile | unlimited challenges, 20 widgets | LLM strategy only |

**Deliberately no KV.** There is no mutable server state: artifacts are static, simulation is client-side, and the LLM path caches nothing worth persisting. Avoiding KV entirely sidesteps the 1,000-writes/day constraint rather than engineering around it.

### LLM cost per run

An LLM strategy run of 10 rounds is 10 calls. At roughly 1,500 input and 400 output tokens per call on `@cf/meta/llama-3.2-3b-instruct` (4,625 neurons per million input tokens, 30,475 per million output), that's about **19 neurons per call, ~190 per full run** — roughly **50 full LLM runs per day** inside the free allocation.

Mitigations:

- The LLM strategy is **off by default**, enabled by an explicit toggle. Most visitors run the three free strategies and see the core insight at zero cost.
- Ship **one pre-recorded exemplar run** (committed as a static JSON file, reasoning text included) so every visitor can see what the LLM strategy looks like without spending anything. This is the single highest-leverage cost decision in the project.
- Optional "bring your own API key" field for users who want a stronger model.
- Circuit breaker: when the daily neuron estimate crosses threshold, disable live LLM runs and fall back to the exemplar with an honest note.

---

## 9. Abuse controls

Scoped tightly, because only one endpoint costs anything.

**Ungated:** all static assets, all three non-LLM strategies, the exemplar run. No rate limit, no Turnstile, no friction. This is most of the product.

**Gated:** `POST /api/llm-move`.

```toml
[[ratelimits]]
name = "LLM_LIMITER"
namespace_id = "2001"
  [ratelimits.simple]
  limit = 12
  period = 60
```

Keyed on `CF-Connecting-IP`. `period` must be 10 or 60 seconds.

> ⚠️ Rate limits are enforced **per Cloudflare location**, so a distributed client gets a higher effective global limit. This is a loose filter, not strict abuse prevention. The circuit breaker is the actual backstop.

**Turnstile** is required once per simulation session, not per round — a 10-round run should not mean 10 challenges. Issue a short-lived signed session token on successful verification and accept that for the remainder of the run.

**Circuit breaker:** SQLite-backed Durable Object tracking estimated daily neuron spend (SQLite-backed classes are required for Durable Objects on the Workers Free plan). At threshold, `/api/llm-move` returns `AI_BUDGET_EXHAUSTED` and the frontend transparently switches to the exemplar run.

Account stays on the Workers **Free** plan, so overspend is impossible by construction.

---

## 10. API

### `POST /api/llm-move`

```json
{
  "sessionToken": "…",
  "currentVariant": [1234, 5678],
  "candidates": [[1234, 5678, 9012], [1234, 3456]],
  "history": [
    { "variant": [1234], "brightness": 3.41, "round": 1 }
  ],
  "round": 4
}
```

Response:

```json
{
  "picks": [0, 3, 7],
  "reasoning": "Position 65 sits in the chromophore, so I'm avoiding it entirely…",
  "neuronsEstimated": 19
}
```

`picks` are indices into `candidates`. The server never sends brightness for untried candidates and the client must not include it in the request — enforce this server-side by rejecting any request whose `candidates` carry score fields.

### `POST /api/session`

Turnstile verification → short-lived session token.

### Error codes

`RATE_LIMITED`, `TURNSTILE_FAILED`, `SESSION_EXPIRED`, `AI_BUDGET_EXHAUSTED`, `INVALID_REQUEST`.

---

## 11. Narrative framing

The app should read as a story with three acts, because the insight is sequential:

1. **The setup.** This is GFP. It glows. Here's the real experiment that measured 50,000 versions of it.
2. **The race.** Pick strategies, watch them climb or die. Live chart, structure view, running commentary.
3. **The lesson.** Why the protein language model won. Why the LLM's confident reasoning didn't translate. What a narrow fitness peak means, and why protein engineering is hard.

A "so what?" panel at the end connects this to real drug and enzyme design.

The tone is honest about its own limits: a restricted search space, no epistasis in the ESM scoring, a small model. Naming those openly is what distinguishes an explainer from a demo.

---

## 12. Open questions

1. Should the user be able to play as a fifth strategy? Appealing, and almost certainly humbling. Probably v2.
2. Is 10 rounds the right length to show separation without boring people? Tune against the real data during M3.
3. Worth adding a per-position mutational-tolerance heatmap as a static view? Cheap to produce from the same artifacts and highly legible — likely yes.

---

## 13. Attribution

Required in README and in-app:

- Sarkisyan, K.S. et al. (2016). *Local fitness landscape of the green fluorescent protein.* Nature 533:397–401. doi:10.1038/nature17995
- Notin, P. et al. (2023). *ProteinGym: Large-Scale Benchmarks for Protein Fitness Prediction and Design.* NeurIPS Datasets and Benchmarks.
- ESM-2 (Lin et al., Meta AI), UniProt, AlphaFold DB / EMBL-EBI.