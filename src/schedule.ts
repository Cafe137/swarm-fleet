/**
 * Admission control.
 *
 * `CLAUDE.md` is emphatic that staggered starts are a correctness requirement,
 * not politeness: every viewer spends 0.12-0.18 vCPU on its first ~15 s
 * (dialing, TLS, kademlia), so eighty starting at once would want ~10 vCPU on
 * an 8-core box and every join-latency number from that run would be garbage.
 *
 * A fixed inter-start delay implements that badly — too slow on an idle box,
 * too fast on a loaded one. So the gate is a CPU budget instead, seeded with
 * the priors from `CLAUDE.md` and replaced by measured cost once the run has
 * enough samples to know better. The minimum interval survives alongside it for
 * a different reason: not hammering the bootnodes.
 */

import type { AdmissionConfig } from './transport/protocol.js';
import { quantile } from './metrics/percentile.js';

/** Priors from CLAUDE.md's CPU measurements on an M1. */
export const DEFAULT_ADMISSION: AdmissionConfig = {
  bootstrapVcpu: 0.18,
  steadyVcpu: 0.03,
  targetUtilisation: 0.7,
  minStartIntervalMs: 250,
  startJitterMs: 100,
  bootstrapTimeoutMs: 15_000,
  disabled: false,
};

/** Observations needed before measured cost is trusted over the prior. */
const MIN_OBSERVATIONS = 6;
const OBSERVATION_WINDOW = 64;

/**
 * Rolling estimate of what a viewer actually costs on this machine.
 *
 * Priors are a starting point, not a truth: an x86 hyperthread should cost
 * 1.5-2.5x an M1 core-second for the same work, and nothing about the fleet
 * should require re-tuning a constant per machine shape.
 */
export class CostModel {
  private readonly bootstrap: number[] = [];
  private readonly steady: number[] = [];

  observe(phase: 'bootstrap' | 'steady', vcpu: number): void {
    if (!Number.isFinite(vcpu) || vcpu < 0) {
      return;
    }
    const series = phase === 'bootstrap' ? this.bootstrap : this.steady;
    series.push(vcpu);
    if (series.length > OBSERVATION_WINDOW) {
      series.shift();
    }
  }

  /** Median, not mean: one viewer hitting a slow DNS server is not the cost. */
  measured(phase: 'bootstrap' | 'steady'): number | undefined {
    const series = phase === 'bootstrap' ? this.bootstrap : this.steady;
    return series.length >= MIN_OBSERVATIONS ? quantile(series, 0.5) : undefined;
  }

  observations(phase: 'bootstrap' | 'steady'): number {
    return (phase === 'bootstrap' ? this.bootstrap : this.steady).length;
  }
}

export interface AdmissionState {
  bootstrapping: number;
  running: number;
}

export interface AdmissionDecision {
  admit: boolean;
  reason: string;
  /** When to ask again. The caller does not spin. */
  retryAfterMs: number;
}

export class AdmissionGate {
  private lastStartAtMs = Number.NEGATIVE_INFINITY;
  private nextIntervalMs: number;

  constructor(
    private readonly cores: number,
    private readonly config: AdmissionConfig,
    private readonly costs: CostModel = new CostModel(),
    private readonly random: () => number = Math.random,
  ) {
    this.nextIntervalMs = this.rollInterval();
  }

  get model(): CostModel {
    return this.costs;
  }

  /** vCPU the budget currently assumes, and where the number came from. */
  budget(): { bootstrapVcpu: number; steadyVcpu: number; source: 'measured' | 'prior' | 'mixed' } {
    const bootstrap = this.costs.measured('bootstrap');
    const steady = this.costs.measured('steady');
    const source =
      bootstrap !== undefined && steady !== undefined
        ? 'measured'
        : bootstrap === undefined && steady === undefined
          ? 'prior'
          : 'mixed';
    return {
      bootstrapVcpu: bootstrap ?? this.config.bootstrapVcpu,
      steadyVcpu: steady ?? this.config.steadyVcpu,
      source,
    };
  }

  decide(nowMs: number, state: AdmissionState): AdmissionDecision {
    if (this.config.disabled) {
      return { admit: true, reason: 'admission control disabled', retryAfterMs: 0 };
    }

    const sinceLast = nowMs - this.lastStartAtMs;
    if (sinceLast < this.nextIntervalMs) {
      return {
        admit: false,
        reason: 'minimum start interval',
        retryAfterMs: Math.ceil(this.nextIntervalMs - sinceLast),
      };
    }

    const { bootstrapVcpu, steadyVcpu } = this.budget();
    const ceiling = this.cores * this.config.targetUtilisation;
    const committed = state.bootstrapping * bootstrapVcpu + state.running * steadyVcpu;
    if (committed + bootstrapVcpu > ceiling) {
      return {
        admit: false,
        reason:
          `cpu budget: ${committed.toFixed(2)} + ${bootstrapVcpu.toFixed(2)} vCPU would exceed ` +
          `${ceiling.toFixed(2)} (${state.bootstrapping} bootstrapping, ${state.running} steady)`,
        // A bootstrap lasts ~15 s, so there is no point asking every 10 ms.
        retryAfterMs: 500,
      };
    }

    return { admit: true, reason: 'within budget', retryAfterMs: 0 };
  }

  noteStart(nowMs: number): void {
    this.lastStartAtMs = nowMs;
    this.nextIntervalMs = this.rollInterval();
  }

  /**
   * Jittered so a fleet of agents does not phase-lock onto the same instants
   * and turn a staggered ramp back into a series of small floods.
   */
  private rollInterval(): number {
    return this.config.minStartIntervalMs + this.random() * this.config.startJitterMs;
  }
}

/** How many viewers each agent should be asked to hold, at a given total. */
export function partition(total: number, weights: readonly number[]): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || weights.length === 0) {
    return weights.map(() => 0);
  }
  const exact = weights.map((weight) => (total * weight) / totalWeight);
  const shares = exact.map((value) => Math.floor(value));
  let remaining = total - shares.reduce((sum, share) => sum + share, 0);
  // Hand the rounding remainder to the largest fractional parts, so a fleet of
  // unequal machines does not systematically starve the same agent.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const { index } of order) {
    if (remaining <= 0) {
      break;
    }
    shares[index] = (shares[index] as number) + 1;
    remaining -= 1;
  }
  return shares;
}
