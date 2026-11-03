import { loadDataset, type Dataset } from "./data/loader.ts";
import { runSimulation } from "./sim/engine.ts";
import { randomSeed } from "./sim/rng.ts";
import { LOCAL_STRATEGIES } from "./sim/strategies/index.ts";
import {
  createExemplarStrategy,
  createLiveLlmStrategy,
  exemplarConfigMatches,
  LLM_KNOWS,
  LLM_LABEL,
  LlmError,
  type ExemplarRun,
} from "./sim/strategies/llm.ts";
import type { RoundResult, SimConfig, Strategy, StrategyId } from "./sim/types.ts";
import { createRaceChart, type RaceChart } from "./ui/chart.ts";
import { $, el } from "./ui/dom.ts";
import { createSession, fetchApiConfig, fetchExemplar, httpTransport, solveTurnstile, type ApiConfig } from "./ui/llmSession.ts";
import { commentary, renderLesson, renderReasoning, renderSetup } from "./ui/narrative.ts";
import { STRATEGY_COLOR } from "./ui/palette.ts";
import { renderDarkCounters, renderScoreboard, standings } from "./ui/scoreboard.ts";
import { createStructureView, positionOutcomes, type StructureView } from "./ui/structure.ts";
import { parseSettings, sanitizeSeed, serializeSettings, type LlmMode, type RaceSettings } from "./ui/urlState.ts";

const ROUND_DELAY_MS = 650;

let dataset: Dataset;
let chart: RaceChart;
let apiConfig: ApiConfig | null = null;
let exemplar: ExemplarRun | null = null;
let structure: Promise<StructureView> | undefined;
let raceId = 0;
let skip = false;
let results: RoundResult[] = [];
let active: Strategy[] = [];

const fast = new URLSearchParams(location.search).has("fast"); // tests and impatient readers

async function boot() {
  try {
    dataset = await loadDataset();
  } catch (err) {
    $("#loading-text").textContent = `Could not load the data (${(err as Error).message}). Reload to try again.`;
    $("#loading").classList.add("is-error");
    return;
  }
  $("#loading").hidden = true;
  for (const id of ["#setup", "#race"]) $(id).hidden = false;
  renderSetup(dataset);

  const settings = parseSettings(location.search, randomSeed);
  buildStrategyList(settings);
  writeControls(settings);
  chart = createRaceChart($("#chart"), dataset.index.brightness.wildType);
  chart.reset(strategiesFor(settings, null), settings.config.rounds);
  wireControls();
  lazyStructure();

  [apiConfig, exemplar] = await Promise.all([fetchApiConfig(), fetchExemplar()]);
  updateLlmNote();
  document.body.dataset.ready = "true";
}

// --- controls -----------------------------------------------------------------

function strategyMeta(): { id: StrategyId; label: string; knows: string }[] {
  return [...LOCAL_STRATEGIES.map(({ id, label, knows }) => ({ id, label, knows })), { id: "llm", label: LLM_LABEL, knows: LLM_KNOWS }];
}

function buildStrategyList(settings: RaceSettings) {
  $("#strategy-list").replaceChildren(
    ...strategyMeta().map((s) =>
      el("label", { class: "strategy-card", style: `--accent:${STRATEGY_COLOR[s.id]}` }, [
        Object.assign(el("input", { type: "checkbox", name: "strategy", value: s.id }), { checked: settings.strategies.includes(s.id) }),
        el("span", { class: "strategy-name" }, [s.label, s.id === "llm" ? el("span", { class: "badge" }, ["optional"]) : null]),
        el("span", { class: "strategy-knows" }, [s.knows]),
      ]),
    ),
  );
}

function writeControls(s: RaceSettings) {
  ($("#seed") as HTMLInputElement).value = s.seed;
  ($("#rounds") as HTMLInputElement).value = String(s.config.rounds);
  ($("#per-round") as HTMLInputElement).value = String(s.config.proposalsPerRound);
  ($("#radius") as HTMLInputElement).value = String(s.config.radius);
  const radio = document.querySelector<HTMLInputElement>(`input[name=llm-mode][value=${s.llmMode}]`);
  if (radio) radio.checked = true;
  $("#llm-mode").hidden = !s.strategies.includes("llm");
}

function readControls(): RaceSettings {
  const num = (id: string) => Number(($(id) as HTMLInputElement).value);
  const checked = [...document.querySelectorAll<HTMLInputElement>("input[name=strategy]:checked")].map((i) => i.value as StrategyId);
  const mode = document.querySelector<HTMLInputElement>("input[name=llm-mode]:checked")?.value as LlmMode | undefined;
  return parseSettings(
    serializeSettings({
      seed: sanitizeSeed(($("#seed") as HTMLInputElement).value) ?? randomSeed(),
      config: { rounds: num("#rounds"), proposalsPerRound: num("#per-round"), radius: num("#radius") },
      strategies: checked,
      llmMode: mode ?? "recorded",
    }),
    randomSeed,
  );
}

function syncUrl(s: RaceSettings) {
  const keep = fast ? "&fast=1" : "";
  history.replaceState(null, "", `${location.pathname}${serializeSettings(s)}${keep}`);
}

function wireControls() {
  const form = $("#controls") as HTMLFormElement;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void startRace(readControls());
  });
  form.addEventListener("change", () => {
    const s = readControls();
    $("#llm-mode").hidden = !s.strategies.includes("llm");
    updateLlmNote();
    syncUrl(s);
  });
  $("#reseed").addEventListener("click", () => {
    ($("#seed") as HTMLInputElement).value = randomSeed();
    syncUrl(readControls());
  });
  $("#skip").addEventListener("click", () => (skip = true));
  $("#share").addEventListener("click", async () => {
    const s = readControls();
    syncUrl(s);
    const url = `${location.origin}${location.pathname}${serializeSettings(s)}`;
    try {
      await navigator.clipboard.writeText(url);
      status("Link copied. Anyone opening it reruns this exact race.");
    } catch {
      status(url);
    }
  });
  $("#structure-strategy").addEventListener("change", () => void refreshStructure());
}

function updateLlmNote() {
  const s = readControls();
  const note = $("#llm-note");
  if (!s.strategies.includes("llm")) return;
  if (s.llmMode === "recorded") {
    note.textContent = exemplar
      ? `Plays back a run recorded with ${exemplar.model} on ${exemplar.recordedAt.slice(0, 10)} (${exemplar.config.rounds} rounds × ${exemplar.config.proposalsPerRound}, max ${exemplar.config.radius} mutations away). Costs nothing.`
      : "No recorded run is available.";
  } else {
    note.textContent = apiConfig?.available
      ? `Asks ${apiConfig.model} live, once per round. One quick human check first.`
      : "Live runs aren't available right now; the recorded run is.";
  }
}

function status(text: string) {
  $("#race-status").textContent = text;
}

// --- race -------------------------------------------------------------------

function strategiesFor(s: RaceSettings, llm: Strategy | null): Strategy[] {
  const local = LOCAL_STRATEGIES.filter((x) => s.strategies.includes(x.id));
  return llm ? [...local, llm] : local;
}

/** Resolve the LLM strategy for these settings, or explain why it can't run. */
async function prepareLlm(s: RaceSettings, onBudgetExhausted: () => void): Promise<{ strategy: Strategy | null; config: SimConfig; note: string }> {
  if (!s.strategies.includes("llm")) return { strategy: null, config: s.config, note: "" };

  if (s.llmMode === "live" && apiConfig?.available) {
    status("One quick check before the live LLM runs…");
    const token = await solveTurnstile(apiConfig.turnstileSiteKey, $("#turnstile-widget"));
    const session = await createSession(token);
    const strategy = createLiveLlmStrategy(httpTransport(session), (err) => {
      if (err.code === "AI_BUDGET_EXHAUSTED") onBudgetExhausted();
    });
    return { strategy, config: s.config, note: `Live answers from ${apiConfig.model}.` };
  }

  if (!exemplar) return { strategy: null, config: s.config, note: "The LLM strategy is unavailable here." };
  const fallbackNote = s.llmMode === "live" ? "Live runs aren't available right now, so this is the recorded run. " : "";
  if (exemplarConfigMatches(exemplar, s.config)) {
    return { strategy: createExemplarStrategy(exemplar), config: s.config, note: `${fallbackNote}Pre-recorded run (${exemplar.model}).` };
  }
  // the recording only replays faithfully under the settings it was made with
  const config = { ...exemplar.config, rounds: Math.min(s.config.rounds, exemplar.config.rounds) };
  return {
    strategy: createExemplarStrategy(exemplar),
    config,
    note: `${fallbackNote}Pre-recorded run (${exemplar.model}); settings switched to the ones it was recorded with.`,
  };
}

async function startRace(requested: RaceSettings) {
  const id = ++raceId;
  skip = fast;
  let budgetExhausted = false;

  let llm: Awaited<ReturnType<typeof prepareLlm>>;
  try {
    llm = await prepareLlm(requested, () => (budgetExhausted = true));
  } catch (err) {
    console.warn("live LLM setup failed", err);
    const msg = err instanceof LlmError ? err.message : (err as Error).message;
    status(`Live LLM unavailable (${msg}). Switching to the recorded run.`);
    llm = await prepareLlm({ ...requested, llmMode: "recorded" }, () => {});
  }
  if (id !== raceId) return;

  const settings: RaceSettings = { ...requested, config: llm.config };
  writeControls(settings);
  syncUrl(settings);
  active = strategiesFor(settings, llm.strategy);
  if (active.length === 0) {
    status("Pick at least one strategy.");
    return;
  }

  results = [];
  chart.reset(active, settings.config.rounds);
  renderDarkCounters($("#dark-counters"), results, active);
  ($("#scoreboard") as HTMLTableSectionElement).replaceChildren();
  $("#commentary").replaceChildren();
  $("#reasoning").replaceChildren();
  $("#reasoning-panel").hidden = !llm.strategy;
  $("#reasoning-source").textContent = llm.note;
  $("#lesson").hidden = true;
  fillStructureSelect();
  void refreshStructure();
  ($("#skip") as HTMLButtonElement).disabled = false;
  ($("#run") as HTMLButtonElement).textContent = "Restart";
  document.body.dataset.race = "running";

  for await (const result of runSimulation(dataset, active, settings.config, settings.seed)) {
    if (id !== raceId) return;
    results.push(result);
    chart.push(result);
    renderScoreboard($("#scoreboard") as HTMLTableSectionElement, results, active, dataset.index.brightness.wildType);
    renderDarkCounters($("#dark-counters"), results, active);
    $("#commentary").prepend(commentary(result, active));
    renderReasoning($("#reasoning"), result, dataset);
    void refreshStructure();
    status(`Round ${result.round} of ${settings.config.rounds} · seed ${settings.seed}`);

    if (budgetExhausted && settings.llmMode === "live") {
      status("Today's live LLM budget is spent. Replaying this race with the recorded run instead.");
      void startRace({ ...settings, llmMode: "recorded" });
      return;
    }
    if (!skip) await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
  }
  if (id !== raceId) return;

  ($("#skip") as HTMLButtonElement).disabled = true;
  document.body.dataset.race = "done";
  status(`Finished · seed ${settings.seed} · same seed, same race`);
  renderLesson($("#lesson-body"), standings(results, active), dataset);
  $("#lesson").hidden = false;
}

// --- structure ----------------------------------------------------------------

function lazyStructure() {
  const panel = $("#structure");
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      $(".structure-status", panel).textContent = "Loading the 3D structure…";
      structure = createStructureView(panel, `/artifacts/${dataset.reference.structure.file}`, dataset.reference.chromophore);
      void refreshStructure();
    }
  });
  io.observe(panel);
}

function fillStructureSelect() {
  const select = $("#structure-strategy") as HTMLSelectElement;
  const previous = select.value;
  select.replaceChildren(...active.map((s) => el("option", { value: s.id }, [s.label])));
  select.value = active.some((s) => s.id === previous) ? previous : (active.find((s) => s.id === "profile") ?? active[0])?.id ?? "";
}

async function refreshStructure() {
  if (!structure) return;
  const view = await structure;
  const id = ($("#structure-strategy") as HTMLSelectElement).value as StrategyId;
  const proposals = results.flatMap((r) => r.perStrategy[id]?.proposals ?? []);
  await view.highlight(positionOutcomes(proposals));
}

void boot();
