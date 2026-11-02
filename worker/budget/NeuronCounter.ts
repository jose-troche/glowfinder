// Circuit breaker: estimated Workers AI neuron spend per UTC day, in one SQLite-backed
// Durable Object (SQLite-backed classes are required on the Workers Free plan).
// A single global instance serialises every reservation, so check-and-add is atomic.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

export interface BudgetStatus {
  day: string;
  spent: number;
  budget: number;
  exhausted: boolean;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class NeuronCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, neurons REAL NOT NULL)");
    });
  }

  private spent(day: string): number {
    const row = this.ctx.storage.sql.exec<{ neurons: number }>("SELECT neurons FROM spend WHERE day = ?", day).toArray()[0];
    return row?.neurons ?? 0;
  }

  private add(day: string, neurons: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO spend (day, neurons) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons",
      day,
      neurons,
    );
  }

  status(budget: number, now = Date.now()): BudgetStatus {
    const day = utcDay(now);
    const spent = this.spent(day);
    return { day, spent, budget, exhausted: spent >= budget };
  }

  /** Reserve an estimated spend before calling the model; refuses at or past the budget. */
  reserve(estimate: number, budget: number, now = Date.now()): BudgetStatus & { granted: boolean } {
    const day = utcDay(now);
    const spent = this.spent(day);
    if (spent + estimate > budget) return { day, spent, budget, exhausted: true, granted: false };
    this.add(day, estimate);
    return { day, spent: spent + estimate, budget, exhausted: spent + estimate >= budget, granted: true };
  }

  /** Correct a reservation once the real usage is known (delta may be negative). */
  adjust(delta: number, now = Date.now()): void {
    if (delta !== 0) this.add(utcDay(now), delta);
  }
}

export function counter(ns: DurableObjectNamespace<NeuronCounter>) {
  return ns.get(ns.idFromName("global"));
}
