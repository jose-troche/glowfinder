// The three acts. Act 1 is static facts about the dataset; act 3 is generated from the
// race that actually happened, so the story never claims something the run didn't show.

import { formatVariant } from "../data/codec.ts";
import type { Dataset } from "../data/loader.ts";
import type { RoundResult, Strategy } from "../sim/types.ts";
import { el } from "./dom.ts";
import { STRATEGY_COLOR } from "./palette.ts";
import { foldOver, verdict, type Standing } from "./scoreboard.ts";

const pct = (x: number) => `${Math.round(100 * x)}%`;

// --- act 1 ------------------------------------------------------------------

export interface PositionTolerance {
  /** fraction of variants mutated at this position that still glow; NaN if none */
  fractionVisible: Float32Array;
  variants: Uint32Array;
}

export function toleranceByPosition(ds: Dataset): PositionTolerance {
  const L = ds.index.sequenceLength;
  const visible = new Uint32Array(L);
  const variants = new Uint32Array(L);
  const threshold = ds.index.brightness.visibleThreshold;
  for (let i = 0; i < ds.count; i++) {
    const glows = ds.brightness[i]! > threshold;
    for (let k = ds.offsets[i]!; k < ds.offsets[i + 1]!; k++) {
      const pos = Math.floor(ds.codes[k]! / 20);
      variants[pos]!++;
      if (glows) visible[pos]!++;
    }
  }
  const fractionVisible = new Float32Array(L);
  for (let p = 0; p < L; p++) fractionVisible[p] = variants[p] ? visible[p]! / variants[p]! : NaN;
  return { fractionVisible, variants };
}

/** red (0) -> amber -> green (1) */
export function toleranceColor(f: number): string {
  if (Number.isNaN(f)) return "#2a3138";
  const hue = 355 + f * 140; // 355 -> 135 (wraps through red/amber/green)
  return `hsl(${hue % 360} 75% ${38 + f * 14}%)`;
}

export function renderSetup(ds: Dataset): void {
  const s = ds.index.summary;
  const byDepth = (d: number) => s.byDepth.find((r) => r.depth === d);
  const set = (id: string, text: string) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  set("stat-variants", s.variantsShipped.toLocaleString("en-US"));
  set("stat-visible", pct(s.fractionVisible));
  set("stat-single", pct(byDepth(1)?.fractionVisible ?? 0));
  set("stat-four", pct(byDepth(4)?.fractionVisible ?? 0));
  set("stat-wt", ds.index.brightness.wildType.toFixed(2));

  const bars = document.getElementById("depth-bars");
  if (bars) {
    bars.replaceChildren(
      ...s.byDepth
        .filter((r) => r.depth >= 1 && r.depth <= 10)
        .map((r) =>
          el("div", { class: "depth-bar", role: "listitem" }, [
            el("span", { class: "depth-label" }, [`${r.depth}`]),
            el("span", { class: "depth-track" }, [
              el("span", { class: "depth-fill", style: `width:${(100 * r.fractionVisible).toFixed(1)}%` }),
            ]),
            el("span", { class: "depth-value" }, [`${pct(r.fractionVisible)} of ${r.variants.toLocaleString("en-US")}`]),
          ]),
        ),
    );
  }
  renderHeatmap(ds);
}

function renderHeatmap(ds: Dataset): void {
  const canvas = document.getElementById("heatmap") as HTMLCanvasElement | null;
  const caption = document.getElementById("heatmap-caption");
  if (!canvas || !caption) return;
  const tol = toleranceByPosition(ds);
  const L = ds.index.sequenceLength;
  const { start, end } = ds.reference.chromophore;
  const draw = () => {
    const width = canvas.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(48 * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const w = width / L;
    for (let p = 0; p < L; p++) {
      ctx.fillStyle = toleranceColor(tol.fractionVisible[p]!);
      ctx.fillRect(p * w, 0, Math.ceil(w), 36);
    }
    ctx.fillStyle = "#d9ff66";
    ctx.fillRect((start - 1) * w, 38, (end - start + 1) * w, 6);
  };
  draw();
  new ResizeObserver(draw).observe(canvas);

  const describe = (p: number) => {
    const f = tol.fractionVisible[p - 1]!;
    const n = tol.variants[p - 1]!;
    const aa = ds.reference.sequence[p - 1];
    const tag = p >= start && p <= end ? " · chromophore" : ds.reference.burial.buried[p - 1] ? " · buried" : " · surface";
    return Number.isNaN(f)
      ? `Position ${p} (${aa}${tag}): never mutated in the experiment.`
      : `Position ${p} (${aa}${tag}): ${pct(f)} of ${n.toLocaleString("en-US")} variants mutated here still glow.`;
  };
  const initial = caption.textContent;
  canvas.addEventListener("pointermove", (e) => {
    const p = Math.min(L, Math.max(1, Math.floor((e.offsetX / canvas.clientWidth) * L) + 1));
    caption.textContent = describe(p);
  });
  canvas.addEventListener("pointerleave", () => (caption.textContent = initial));
}

// --- act 2 ------------------------------------------------------------------

export function commentary(result: RoundResult, strategies: readonly Strategy[]): HTMLElement {
  const parts = strategies.flatMap((s) => {
    const r = result.perStrategy[s.id];
    if (!r) return [];
    const top = r.proposals.reduce((a, b) => (b.brightness > a.brightness ? b : a), r.proposals[0]!);
    const what = r.dark === 0 ? "all glow" : `${r.dark} dark`;
    return [
      el("span", { class: "comment-part" }, [
        el("span", { class: "swatch", style: `background:${STRATEGY_COLOR[s.id]}` }),
        `${s.label}: ${what}, top ${top ? top.brightness.toFixed(2) : "–"}`,
        r.fallback ? " (fallback)" : "",
      ]),
    ];
  });
  return el("li", {}, [el("strong", {}, [`Round ${result.round}`]), " ", ...parts]);
}

export function renderReasoning(container: HTMLElement, result: RoundResult, ds: Dataset): void {
  const r = result.perStrategy.llm;
  if (!r) return;
  const picks = r.proposals
    .map((p) => `${formatVariant(p.codes, ds.reference.sequence, ds.index)} → ${p.brightness.toFixed(2)}${p.isDark ? " dark" : ""}`)
    .join("; ");
  container.prepend(
    el("article", { class: `reasoning${r.fallback ? " is-fallback" : ""}`, "data-round": String(result.round) }, [
      el("header", {}, [`Round ${result.round}`, r.fallback ? el("span", { class: "badge" }, ["fallback"]) : null]),
      el("p", { class: "reasoning-text" }, [r.reasoning || (r.fallback ? r.fallbackReason ?? "No usable answer; random picks." : "(no reasoning given)")]),
      el("p", { class: "reasoning-picks" }, [picks]),
    ]),
  );
}

// --- act 3 ------------------------------------------------------------------

export function renderLesson(container: HTMLElement, ranked: readonly Standing[], ds: Dataset): void {
  const wt = ds.index.brightness.wildType;
  const by = (id: string) => ranked.find((s) => s.strategy.id === id);
  const winner = ranked[0];
  const models = ds.index.models;
  const blocks: HTMLElement[] = [];

  if (winner) {
    blocks.push(
      el("p", { class: "lede" }, [
        el("strong", { style: `color:${STRATEGY_COLOR[winner.strategy.id]}` }, [winner.strategy.label]),
        ` finished on top: ${foldOver(winner.totals.best, wt).toFixed(2)}× as bright as wild type, with ${winner.totals.dark} dark proposal${winner.totals.dark === 1 ? "" : "s"}.`,
      ]),
    );
  }

  blocks.push(
    el(
      "ul",
      { class: "verdicts" },
      ranked.map((s) =>
        el("li", { "data-strategy": s.strategy.id }, [
          el("span", { class: "swatch", style: `background:${STRATEGY_COLOR[s.strategy.id]}` }),
          el("strong", {}, [s.strategy.label]),
          ` — ${verdict(s, wt, ranked)}`,
        ]),
      ),
    ),
  );

  const profile = by("profile");
  if (profile) {
    blocks.push(
      section("Why knowing the family wins", [
        `The evolutionary profile is a table of which amino acids ~400 natural relatives of GFP carry at each position. ` +
          `Where evolution has tolerated a residue, swapping to it is usually safe. That one table correlates with the ` +
          `measured brightness at Spearman ρ = ${models.profile.spearman.toFixed(2)} — and it has never seen this experiment.`,
      ]),
    );
  }

  const esm = by("esm");
  if (esm) {
    const vsRandom = by("random");
    const compare = vsRandom
      ? esm.totals.dark > vsRandom.totals.dark
        ? "more dark proposals than random"
        : esm.totals.dark < vsRandom.totals.dark
          ? "fewer dark proposals than random"
          : "as many dark proposals as random"
      : `${esm.totals.dark} dark proposals`;
    blocks.push(
      section("Why the protein language model struggled", [
        `ESM-2 learned from tens of millions of protein sequences and is a strong zero-shot predictor for many proteins. ` +
          `On GFP its score correlates with brightness at only ρ = ${models.esm.spearman.toFixed(2)} (ProteinGym reports the same ` +
          `for this model), and this run it made ${compare}. GFP has few relatives in its training data. Domain-specific ` +
          `training only helps when the domain covers your protein.`,
      ]),
    );
  }

  const llm = by("llm");
  if (llm) {
    const references = [by("random"), profile].filter((x): x is Standing => !!x);
    const relation = references
      .map((r) => {
        const d = llm.totals.dark - r.totals.dark;
        return `${d > 0 ? `${d} more` : d < 0 ? `${-d} fewer` : "the same number"} than ${r.strategy.label.toLowerCase()}`;
      })
      .join(", ");
    blocks.push(
      section("Why confident reasoning didn't translate", [
        `The LLM wrote plausible arguments about the barrel and the chromophore. ${llm.totals.dark} of its ` +
          `${llm.totals.proposals} proposals went dark${relation ? ` — ${relation}` : ""}. Fluent reasoning about chemistry ` +
          `is not the same as knowing which residues this protein tolerates; read its notes above against the results.`,
      ]),
    );
  }

  const s = ds.index.summary;
  const depth = (d: number) => s.byDepth.find((r) => r.depth === d)?.fractionVisible ?? 0;
  const brighter = s.byDepth.reduce((a, r) => a + r.brighterThanWildType, 0);
  blocks.push(
    section("How narrow the peak is", [
      `Across the whole experiment, ${pct(depth(1))} of single mutants still glow; with four mutations only ${pct(depth(4))} do, ` +
        `and with eight, ${pct(depth(8))}. Only ${brighter.toLocaleString("en-US")} of ${s.variantsShipped.toLocaleString("en-US")} ` +
        `variants beat wild type at all. Good paths are a thin ridge through an enormous dark space — and because mutations ` +
        `interact (epistasis), a score that simply adds up single-mutation effects is wrong more often the further you go.`,
    ]),
  );

  container.replaceChildren(...blocks);
}

function section(title: string, paragraphs: string[]): HTMLElement {
  return el("section", { class: "lesson-block" }, [el("h3", {}, [title]), ...paragraphs.map((p) => el("p", {}, [p]))]);
}
