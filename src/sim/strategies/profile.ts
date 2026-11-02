import type { Strategy } from "../types.ts";
import { topByModel } from "./esm.ts";

/**
 * Evolutionary profile, zero-shot: per-position amino-acid frequencies across
 * ~400 natural relatives of GFP (ProteinGym's alignment). Knows which residues
 * evolution tolerates at each position; never saw this experiment.
 */
export const profileStrategy: Strategy = {
  id: "profile",
  label: "Evolution",
  knows: "Which residues ~400 natural GFP relatives tolerate at each position",
  propose: (ctx) => ({ picks: topByModel("profile", ctx) }),
};
