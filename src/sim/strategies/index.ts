import type { Strategy } from "../types.ts";
import { conservativeStrategy } from "./conservative.ts";
import { esmStrategy } from "./esm.ts";
import { profileStrategy } from "./profile.ts";
import { randomStrategy } from "./random.ts";

/** The strategies that run entirely in the browser, at zero cost. */
export const LOCAL_STRATEGIES: readonly Strategy[] = [randomStrategy, conservativeStrategy, esmStrategy, profileStrategy];

export { conservativeStrategy, esmStrategy, profileStrategy, randomStrategy };
