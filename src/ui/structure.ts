// 3D structure (AlphaFold AF-P42212-F1) with the chromophore marked and each mutated
// position coloured by what happened to the variants that touched it. Mol* is large,
// so it is imported only when the view is first shown; without WebGL the view says so.

import type { ScoredProposal } from "../sim/types.ts";
import { OUTCOME_COLOR } from "./palette.ts";

export type Outcome = keyof typeof OUTCOME_COLOR;

export interface StructureView {
  /** Replace highlights: position -> outcome. */
  highlight(outcomes: Map<number, Outcome>): Promise<void>;
  readonly state: "loading" | "ready" | "unavailable";
}

/** All variants touching a position glowed -> bright; all went dark -> dark; else mixed. */
export function positionOutcomes(proposals: readonly ScoredProposal[], width = 20): Map<number, Outcome> {
  const seen = new Map<number, { glow: number; dark: number }>();
  for (const p of proposals) {
    for (const code of p.codes) {
      const pos = Math.floor(code / width) + 1;
      const s = seen.get(pos) ?? { glow: 0, dark: 0 };
      if (p.isDark) s.dark++;
      else s.glow++;
      seen.set(pos, s);
    }
  }
  const out = new Map<number, Outcome>();
  for (const [pos, s] of seen) out.set(pos, s.dark === 0 ? "bright" : s.glow === 0 ? "dark" : "mixed");
  return out;
}

const hex = (css: string) => Number.parseInt(css.slice(1), 16);

export async function createStructureView(
  container: HTMLElement,
  pdbUrl: string,
  chromophore: { start: number; end: number },
): Promise<StructureView> {
  const view = { state: "loading" as StructureView["state"] };
  container.dataset.state = "loading";
  const fail = (why: string) => {
    view.state = "unavailable";
    container.dataset.state = "unavailable";
    container.querySelector(".structure-status")!.textContent = `3D view unavailable here (${why}). The race and scores are unaffected.`;
    return { ...view, highlight: async () => {} };
  };

  const canvas = document.createElement("canvas");
  const host = document.createElement("div");
  host.className = "structure-canvas";
  host.appendChild(canvas);
  const caption = container.querySelector("figcaption");
  if (caption) caption.after(host);
  else container.prepend(host);

  try {
    const probe = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!probe) return fail("no WebGL");

    const [{ PluginContext }, { DefaultPluginSpec }, { MolScriptBuilder: MS }, { Color }] = await Promise.all([
      import("molstar/lib/mol-plugin/context.js"),
      import("molstar/lib/mol-plugin/spec.js"),
      import("molstar/lib/mol-script/language/builder.js"),
      import("molstar/lib/mol-util/color/index.js"),
    ]);

    const plugin = new PluginContext(DefaultPluginSpec());
    await plugin.init();
    if (!(await plugin.initViewerAsync(canvas, host))) return fail("viewer did not start");
    plugin.canvas3d?.setProps({ renderer: { backgroundColor: Color(0x0b1016) } });

    const residues = (positions: number[]) =>
      MS.struct.generator.atomGroups({
        "residue-test": MS.core.set.has([MS.set(...positions), MS.ammp("auth_seq_id")]),
      });

    const data = await plugin.builders.data.download({ url: pdbUrl, isBinary: false });
    const trajectory = await plugin.builders.structure.parseTrajectory(data, "pdb");
    const model = await plugin.builders.structure.createModel(trajectory);
    const structure = await plugin.builders.structure.createStructure(model);
    const polymer = await plugin.builders.structure.tryCreateComponentStatic(structure, "polymer");
    if (polymer) {
      await plugin.builders.structure.representation.addRepresentation(polymer, {
        type: "cartoon",
        color: "uniform",
        colorParams: { value: Color(0x2b5d46) },
        typeParams: { alpha: 0.55 },
      });
    }
    const chromo: number[] = [];
    for (let p = chromophore.start; p <= chromophore.end; p++) chromo.push(p);
    const chromoComponent = await plugin.builders.structure.tryCreateComponentFromExpression(structure, residues(chromo), "chromophore", { label: "Chromophore" });
    if (chromoComponent) {
      await plugin.builders.structure.representation.addRepresentation(chromoComponent, {
        type: "ball-and-stick",
        color: "uniform",
        colorParams: { value: Color(0xd9ff66) },
      });
    }

    let refs: string[] = [];
    let queue = Promise.resolve();
    view.state = "ready";
    container.dataset.state = "ready";
    container.querySelector(".structure-status")!.textContent = "";

    return {
      get state() {
        return view.state;
      },
      highlight(outcomes) {
        // serialise updates: a fast race can call this faster than Mol* commits
        queue = queue.then(async () => {
          const del = plugin.build();
          for (const ref of refs) del.delete(ref);
          await del.commit();
          refs = [];
          for (const outcome of Object.keys(OUTCOME_COLOR) as Outcome[]) {
            const positions = [...outcomes].filter(([, o]) => o === outcome).map(([p]) => p);
            if (!positions.length) continue;
            const comp = await plugin.builders.structure.tryCreateComponentFromExpression(
              structure,
              residues(positions),
              `outcome-${outcome}-${Date.now()}`,
              { label: outcome },
            );
            if (!comp) continue;
            await plugin.builders.structure.representation.addRepresentation(comp, {
              type: "spacefill",
              color: "uniform",
              colorParams: { value: Color(hex(OUTCOME_COLOR[outcome])) },
              typeParams: { sizeFactor: 0.6 },
            });
            refs.push(comp.ref);
          }
          container.dataset.highlighted = String(outcomes.size);
        });
        return queue;
      },
    };
  } catch (err) {
    console.warn("structure view failed", err);
    return fail("could not load");
  }
}
