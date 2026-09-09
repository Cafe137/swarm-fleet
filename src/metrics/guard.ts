/**
 * Guard KPIs: whether the rig was healthy enough for the subject KPIs to mean
 * anything.
 *
 * A load rig's one fatal failure is reporting the generator's limits as the
 * network's. If viewers stall because the box they run on ran out of CPU, the
 * stall ratio is a fact about the box. So every run carries a verdict, breaches
 * are sticky, and a breached run is reported as invalid with its numbers still
 * written out and flagged — never quietly averaged in.
 */

import type { MachineInfo, MachineSample } from '../transport/protocol.js';
import { quantile } from './percentile.js';

export const GUARD_CPU_LOAD_FRACTION = 0.8;
export const GUARD_MEMORY_FRACTION = 0.8;
export const GUARD_SAMPLER_LAG_MS = 250;
export const GUARD_CLOCK_SKEW_MS = 50;
export const GUARD_STAGGER_VIOLATION_FRACTION = 0.05;
/** Consecutive breaching samples before a guard is considered breached. */
export const GUARD_SUSTAIN_SAMPLES = 3;

export interface GuardVerdict {
  name: string;
  status: 'ok' | 'breached' | 'not_applicable' | 'no_data';
  detail: string;
  value?: number | undefined;
  threshold?: number | undefined;
  firstBreachAtMs?: number | undefined;
}

export interface GuardInput {
  machine: MachineInfo;
  samples: readonly MachineSample[];
  /** Agent-clock timestamps of viewer starts, in order. */
  startTimestamps: readonly number[];
  minStartIntervalMs: number;
  admissionDisabled: boolean;
  clockOffsetMs?: number | undefined;
  /** Smallest control-channel round trip: the offset cannot be known better. */
  clockRttMs?: number | undefined;
  dialFailureSeries: readonly number[];
  /** Viewers bootstrapping at each sample, parallel to `dialFailureSeries`. */
  bootstrappingSeries?: readonly number[] | undefined;
  /**
   * When the measurement window opened, for a run with a settle phase.
   *
   * `cpu_headroom` is judged from here. A settled cohort concentrates every
   * join into one window on purpose — 20 viewers dialing 200 peers each is
   * 4,000 certificate chains — and that burst saturated a 6-core box at 99.6%
   * while *nothing was being measured*. Failing the run for it would report the
   * generator's own start-up as the network's limit, which is the one thing the
   * guards exist to prevent, backwards.
   *
   * Only CPU is scoped this way. Memory is not: a peak RSS is a peak RSS
   * whenever it happened, and a box that nearly ran out of memory settling
   * would not have survived the measurement either.
   */
  measuredFromMs?: number | undefined;
}

/**
 * Per-agent guard evaluation. Each agent is judged on its own machine: one
 * saturated box invalidates the run even if the others were fine, because the
 * viewers on it contributed to the KPIs.
 */
export function evaluateGuards(input: GuardInput): GuardVerdict[] {
  return [
    cpuHeadroom(input),
    memoryHeadroom(input),
    dialFailures(input),
    staggerAdherence(input),
    samplerJitter(input),
    clockSkew(input),
    agentOverhead(input),
  ];
}

export function guardsValid(verdicts: readonly GuardVerdict[]): boolean {
  return verdicts.every((verdict) => verdict.status !== 'breached');
}

function cpuHeadroom({ machine, samples, measuredFromMs }: GuardInput): GuardVerdict {
  const threshold = machine.cores * GUARD_CPU_LOAD_FRACTION;
  const judged =
    measuredFromMs === undefined
      ? samples
      : samples.filter((sample) => sample.atMs >= measuredFromMs);
  const excluded = samples.length - judged.length;
  const breach = sustained(judged, (sample) => sample.loadAvg1 > threshold);
  const worst = judged.reduce((peak, sample) => Math.max(peak, sample.loadAvg1), 0);
  if (judged.length === 0) {
    return {
      name: 'cpu_headroom',
      status: 'no_data',
      detail: samples.length === 0 ? 'no samples' : 'no samples inside the measurement window',
    };
  }
  // Load average is a one-minute average, so the settle phase's burst decays
  // into the first samples after the release however the window is cut. Saying
  // how many samples were excluded is what lets a reader see that.
  const scope = excluded > 0 ? `, ${excluded} settle-phase samples excluded` : '';
  return {
    name: 'cpu_headroom',
    status: breach === undefined ? 'ok' : 'breached',
    detail:
      breach === undefined
        ? `peak load ${worst.toFixed(2)} of ${machine.cores} cores${scope}`
        : `load stayed above ${threshold.toFixed(1)} for ${GUARD_SUSTAIN_SAMPLES} samples ` +
          `(peak ${worst.toFixed(2)})${scope}`,
    value: worst,
    threshold,
    firstBreachAtMs: breach,
  };
}

function memoryHeadroom({ machine, samples }: GuardInput): GuardVerdict {
  // Deliberately not `os.freemem()`. On darwin that reports a fraction of what
  // is actually available (it excludes purgeable and cached pages), so a guard
  // on free memory reads as a breach on an idle Mac. Tracked RSS against total
  // is the figure that means the same thing on both platforms.
  const threshold = machine.totalMemBytes * GUARD_MEMORY_FRACTION;
  const used = (sample: MachineSample): number => sample.viewerRssTotalBytes + sample.agentRssBytes;
  const breach = sustained(samples, (sample) => used(sample) > threshold);
  const worst = samples.reduce((peak, sample) => Math.max(peak, used(sample)), 0);
  if (samples.length === 0) {
    return { name: 'memory_headroom', status: 'no_data', detail: 'no samples' };
  }
  return {
    name: 'memory_headroom',
    status: breach === undefined ? 'ok' : 'breached',
    detail: `peak tracked RSS ${mib(worst)} of ${mib(machine.totalMemBytes)}`,
    value: worst,
    threshold,
    firstBreachAtMs: breach,
  };
}

/**
 * Are dial failures *accumulating* once the fleet has settled?
 *
 * Growth over consecutive ticks rather than a raw count, because a handful of
 * unreachable peers is ordinary and a rising series is the ephemeral-port
 * ceiling. But ticks with viewers still bootstrapping are skipped, and that is
 * not a nicety: a staggered cohort adds a fresh viewer dialing 200 peers every
 * few hundred milliseconds, so failures rise monotonically for the whole ramp
 * and the guard fired on a 4-viewer run holding 805 sockets against 28,000
 * available ports. Growth while viewers are still joining says nothing about a
 * ceiling; growth after they have all joined is the signal.
 */
function dialFailures({ dialFailureSeries, bootstrappingSeries }: GuardInput): GuardVerdict {
  if (dialFailureSeries.length === 0) {
    return { name: 'dial_failures', status: 'no_data', detail: 'viewer does not report dial failures' };
  }
  const total = dialFailureSeries[dialFailureSeries.length - 1] as number;
  const settled = (at: number): boolean =>
    bootstrappingSeries === undefined ||
    ((bootstrappingSeries[at] ?? 0) === 0 && (bootstrappingSeries[at - 1] ?? 0) === 0);

  let run = 0;
  let firstBreach: number | undefined;
  let compared = 0;
  for (let at = 1; at < dialFailureSeries.length; at += 1) {
    if (!settled(at)) {
      run = 0;
      continue;
    }
    compared += 1;
    const grew = (dialFailureSeries[at] as number) > (dialFailureSeries[at - 1] as number);
    run = grew ? run + 1 : 0;
    if (run >= GUARD_SUSTAIN_SAMPLES && firstBreach === undefined) {
      firstBreach = at;
    }
  }
  if (compared === 0) {
    return {
      name: 'dial_failures',
      status: 'no_data',
      detail: `${total} dial failures, all while viewers were still joining`,
      value: total,
    };
  }
  return {
    name: 'dial_failures',
    status: firstBreach === undefined ? 'ok' : 'breached',
    detail:
      firstBreach === undefined
        ? `${total} dial failures, not rising once joined`
        : `dial failures rose for ${GUARD_SUSTAIN_SAMPLES} consecutive ticks after the fleet settled (${total} total) — suspect ephemeral ports, not Swarm`,
    value: total,
    threshold: 0,
  };
}

function staggerAdherence({
  startTimestamps,
  minStartIntervalMs,
  admissionDisabled,
}: GuardInput): GuardVerdict {
  if (admissionDisabled) {
    return {
      name: 'stagger_adherence',
      status: 'not_applicable',
      detail: 'admission control disabled for this scenario; run is not comparable',
    };
  }
  if (startTimestamps.length < 2) {
    return { name: 'stagger_adherence', status: 'no_data', detail: 'fewer than two starts' };
  }
  const floor = minStartIntervalMs * 0.5;
  let violations = 0;
  for (let at = 1; at < startTimestamps.length; at += 1) {
    if ((startTimestamps[at] as number) - (startTimestamps[at - 1] as number) < floor) {
      violations += 1;
    }
  }
  const fraction = violations / (startTimestamps.length - 1);
  return {
    name: 'stagger_adherence',
    status: fraction > GUARD_STAGGER_VIOLATION_FRACTION ? 'breached' : 'ok',
    detail: `${violations} of ${startTimestamps.length - 1} starts closer than ${floor.toFixed(0)} ms`,
    value: fraction,
    threshold: GUARD_STAGGER_VIOLATION_FRACTION,
  };
}

function samplerJitter({ samples }: GuardInput): GuardVerdict {
  const lags = samples.map((sample) => sample.samplerLagMs);
  const p95 = quantile(lags, 0.95);
  if (p95 === undefined) {
    return { name: 'sampler_jitter', status: 'no_data', detail: 'no samples' };
  }
  return {
    name: 'sampler_jitter',
    status: p95 > GUARD_SAMPLER_LAG_MS ? 'breached' : 'ok',
    detail: `sampler p95 lag ${p95.toFixed(0)} ms — above ${GUARD_SAMPLER_LAG_MS} ms means the agent itself was starved`,
    value: p95,
    threshold: GUARD_SAMPLER_LAG_MS,
  };
}

/**
 * Is a clock far enough off to spoil a cross-machine timeline?
 *
 * The threshold is floored at half the smallest round trip, because that is the
 * best anyone can know a remote clock from a request and a reply: calling a
 * 30 ms skew a breach on a 60 ms link claims precision the measurement does not
 * have.
 *
 * The name says `agent`, but the measurement is a *difference* and cannot say
 * which side is wrong. The first real remote run made the point: the agent was
 * 1.9 us off NTP by its own chrony, and the 73 ms belonged entirely to the
 * controller's laptop. So the detail points at the controller, which is both
 * the common cause — one machine against many, and the one nobody checks — and
 * the harder one to notice. `controllerClockSuspect` settles it outright once
 * there are several agents.
 */
function clockSkew({ clockOffsetMs, clockRttMs }: GuardInput): GuardVerdict {
  if (clockOffsetMs === undefined) {
    return { name: 'clock_skew', status: 'no_data', detail: 'offset not measured' };
  }
  const skew = Math.abs(clockOffsetMs);
  const bound = (clockRttMs ?? 0) / 2;
  const threshold = Math.max(GUARD_CLOCK_SKEW_MS, bound);
  return {
    name: 'clock_skew',
    status: skew > threshold ? 'breached' : 'ok',
    detail:
      `agent clock ${clockOffsetMs.toFixed(1)} ms from the controller` +
      (clockRttMs === undefined
        ? ''
        : `, known to no better than ${bound.toFixed(0)} ms on a ${clockRttMs.toFixed(0)} ms round trip`) +
      (skew > threshold
        ? '. Check the controller\'s own clock first: it is one machine against many, and a difference cannot say which side drifted'
        : ''),
    value: skew,
    threshold,
  };
}

function agentOverhead({ samples }: GuardInput): GuardVerdict {
  const peak = samples.reduce((worst, sample) => Math.max(worst, sample.agentRssBytes), 0);
  return {
    name: 'agent_overhead',
    // Informational: recorded so it can be subtracted, never a reason to fail.
    status: samples.length === 0 ? 'no_data' : 'ok',
    detail: `agent process peaked at ${mib(peak)}; subtract it from machine totals`,
    value: peak,
  };
}

/** Agent-clock time of the first sample in the first sustained breach run. */
function sustained(
  samples: readonly MachineSample[],
  breaching: (sample: MachineSample) => boolean,
): number | undefined {
  let run = 0;
  let runStart: number | undefined;
  for (const sample of samples) {
    if (breaching(sample)) {
      run += 1;
      runStart = runStart ?? sample.atMs;
      if (run >= GUARD_SUSTAIN_SAMPLES) {
        return runStart;
      }
    } else {
      run = 0;
      runStart = undefined;
    }
  }
  return undefined;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * Do the agents agree that the controller is the odd one out?
 *
 * Every agent is measured against the same controller, so a fleet whose agents
 * all report the same offset is a fleet with one wrong clock, and it is not
 * theirs. Needs at least two agents: with one, a difference is just a
 * difference.
 */
export function controllerClockSuspect(offsetsMs: readonly number[]): boolean {
  if (offsetsMs.length < 2) {
    return false;
  }
  const sameSide = offsetsMs.every((offset) => Math.abs(offset) > GUARD_CLOCK_SKEW_MS) &&
    (offsetsMs.every((offset) => offset > 0) || offsetsMs.every((offset) => offset < 0));
  if (!sameSide) {
    return false;
  }
  const spread = Math.max(...offsetsMs) - Math.min(...offsetsMs);
  // Agreement, not identity: each measurement carries its own link's error.
  return spread <= GUARD_CLOCK_SKEW_MS;
}
