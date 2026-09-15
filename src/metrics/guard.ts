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
import {
  describePeerShortfall,
  type PeerAttainment,
  summarisePeerAttainment,
} from './peers.js';
import { quantile } from './percentile.js';

export const GUARD_CPU_LOAD_FRACTION = 0.8;
export const GUARD_MEMORY_FRACTION = 0.8;
export const GUARD_SAMPLER_LAG_MS = 250;
/**
 * Drift worth reporting, between an agent's clock and the controller's.
 *
 * A full second, not the 50 ms this started at, because 50 ms was calibrated
 * against a fear rather than against what the offset actually feeds. The
 * controller applies it to exactly two fields per viewer — when it started and
 * when it exited — and nothing else. Every number a run is judged on is either
 * viewer-local or controller-local:
 *
 *   - `degradedFraction`, `realtimeFactor`, `fetch_ms`, `stall_s` are durations
 *     each viewer measures against its own monotonic clock, inside one process.
 *   - `aggregateMbps` divides controller-side bytes by a controller-side window.
 *   - `stagger_adherence` diffs consecutive starts on the *same* agent, so the
 *     offset cancels out of it entirely.
 *
 * So a hundred milliseconds cannot move a single published figure, and failing
 * a run for it told the reader the capacity number was untrustworthy when the
 * defect was a laptop that had not synced NTP recently.
 *
 * A second or more is different in kind: that is a machine whose clock is
 * actually wrong — a suspended laptop, a VM with a bad TSC, NTP not running —
 * and then the cross-machine timeline a multi-agent run stitches together is
 * genuinely smeared, and you want to know before reading the report.
 */
export const GUARD_CLOCK_SKEW_MS = 1_000;
/**
 * How close two agents' offsets must be to count as *agreeing*.
 *
 * Deliberately not `GUARD_CLOCK_SKEW_MS`, though it once was. This is the error
 * on each link's own measurement, not a tolerance for drift, and raising it with
 * the threshold above would have quietly broken the thing it protects: two
 * agents reporting +1.1 s and +2.0 s would have counted as agreement and blamed
 * the controller, when in truth they are 900 ms apart and at least one of them
 * is the problem.
 */
export const GUARD_CLOCK_AGREEMENT_MS = 50;
export const GUARD_STAGGER_VIOLATION_FRACTION = 0.05;
/**
 * Share of viewers allowed to miss their peer footprint before the run is void.
 *
 * A tenth, because a viewer short of its peers is not a degraded viewer but a
 * *smaller* viewer: it opens fewer connections, retrieves over fewer routes and
 * costs the network less, so the fleet is no longer the fleet the run asked for
 * and `aggregateMbps` describes a cohort that did not exist. Healthy cohorts
 * measure 0 here, so this is tolerance for one straggler in ten, not a budget.
 */
export const GUARD_PEER_SHORTFALL_FRACTION = 0.1;
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
  /** Per-viewer peer footprint on this agent, for `peer_target`. */
  peerAttainment?: readonly PeerAttainment[] | undefined;
  /**
   * Report a peer shortfall without invalidating the run.
   *
   * Set for the modes whose whole purpose is to find the point where viewers
   * stop getting their peers — `port-ceiling` and `flood`. There the shortfall
   * is the measurement, and failing the run for finding it would throw away the
   * answer. Everywhere else it means the cohort was never fully built.
   */
  peerTargetAdvisory?: boolean | undefined;
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
    peerTarget(input),
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
 * Did the viewers on this box hold the peer footprint the run asked for?
 *
 * The only guard on the fleet's peering, and the one that matters: a viewer
 * that does not hold its footprint is not generating the load the run claims,
 * whatever else looks healthy. Ask it of the peers themselves — a box where 48
 * viewers sat at zero peers had CPU and memory to spare and nothing else to
 * report it.
 *
 * Judged on final counts rather than peaks on purpose. A NAT table that evicts
 * its oldest entry lets every viewer reach its target and then takes the
 * connections back, so a peak-only check reports a healthy fleet at the exact
 * moment the fleet is dissolving. `summarisePeerAttainment` keeps peak and
 * final apart so the detail line can say which of the two happened.
 */
function peerTarget({ peerAttainment, peerTargetAdvisory }: GuardInput): GuardVerdict {
  if (peerAttainment === undefined || peerAttainment.length === 0) {
    return {
      name: 'peer_target',
      status: 'no_data',
      detail: 'no viewer peer counts for this agent',
    };
  }
  const summary = summarisePeerAttainment(peerAttainment);
  if (summary.judged === 0) {
    return {
      name: 'peer_target',
      status: 'no_data',
      detail:
        `no viewer ran long enough to have joined ` +
        `(${summary.skipped} too young or crashed)`,
    };
  }
  const shortfall = summary.shortfallFraction ?? 0;
  const breached = shortfall > GUARD_PEER_SHORTFALL_FRACTION;
  const detail = describePeerShortfall(summary);
  if (breached && peerTargetAdvisory === true) {
    return {
      name: 'peer_target',
      status: 'not_applicable',
      detail: `${detail} — recorded, not fatal: this mode is looking for that limit`,
      value: shortfall,
      threshold: GUARD_PEER_SHORTFALL_FRACTION,
    };
  }
  return {
    name: 'peer_target',
    status: breached ? 'breached' : 'ok',
    detail: breached
      ? detail
      : `${summary.holding} of ${summary.judged} viewers held their peer footprint`,
    value: shortfall,
    threshold: GUARD_PEER_SHORTFALL_FRACTION,
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
  // Only worth attributing a drift that is worth reporting in the first place:
  // below `GUARD_CLOCK_SKEW_MS` nothing is wrong, so there is nobody to blame.
  const sameSide = offsetsMs.every((offset) => Math.abs(offset) > GUARD_CLOCK_SKEW_MS) &&
    (offsetsMs.every((offset) => offset > 0) || offsetsMs.every((offset) => offset < 0));
  if (!sameSide) {
    return false;
  }
  const spread = Math.max(...offsetsMs) - Math.min(...offsetsMs);
  // Agreement, not identity: each measurement carries its own link's error.
  return spread <= GUARD_CLOCK_AGREEMENT_MS;
}
