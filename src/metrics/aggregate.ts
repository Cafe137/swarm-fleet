/**
 * Cohort KPIs.
 *
 * The headline is `degradedFraction`, not a mean. Load failures are tail
 * events: one viewer's p99 is noise, and a mean stall ratio across 200 viewers
 * hides the twenty that could not watch at all. The fraction of viewers having
 * a bad time is the number that answers "is this concurrency survivable".
 */

import {
  DEGRADED_STALL_RATIO,
  type ViewerOutcome,
  type ViewerRecord,
} from '../viewer/rollup.js';
import { type Distribution, distribution, quantile } from './percentile.js';

export interface CohortKpis {
  viewers: {
    requested: number;
    started: number;
    joined: number;
    watching: number;
    completed: number;
    failed: number;
    byOutcome: Record<ViewerOutcome, number>;
  };
  /** Share of viewers that lost more than 1% of media time to stalling. */
  degradedFraction?: number | undefined;
  degradedViewers: number;
  stallRatio: Distribution;
  stallFreeFraction?: number | undefined;
  joinSuccessRate?: number | undefined;
  joinMs: Distribution;
  /** Above 1 at p95 means the tail of the fleet is losing buffer. */
  realtimeFactorP95?: number | undefined;
  fetchMs: Distribution;
  segments: number;
  bytes: number;
  aggregateMbps?: number | undefined;
  segmentsPerSecond?: number | undefined;
  bodyFailureRate?: number | undefined;
  secondStrikes: number;
  skippedTotal: number;
  gapsLocal: number;
  gapsPublisher: number;
  reconstructProbes: number;
  dialFailures: number;
  peersTotal: number;
  peakRssTotalBytes: number;
  cpuSecondsTotal: number;
  /** Distinct (owner, topic) pairs / viewers. 1 = every viewer its own stream. */
  distinctContentRatio?: number | undefined;
  malformedLines: number;
  unknownEvents: number;
}

const EMPTY_OUTCOMES: Record<ViewerOutcome, number> = {
  running: 0,
  completed: 0,
  stalled_out: 0,
  crashed: 0,
  killed: 0,
  never_joined: 0,
};

/**
 * @param requested how many viewers the scenario asked for, which is not the
 *   same as how many started — the difference is itself a finding.
 * @param windowSeconds wall duration to divide byte and segment totals by.
 */
export function cohortKpis(
  records: readonly ViewerRecord[],
  requested: number,
  windowSeconds: number,
): CohortKpis {
  const byOutcome = { ...EMPTY_OUTCOMES };
  for (const record of records) {
    byOutcome[record.outcome] += 1;
  }

  const withMedia = records.filter((record) => record.mediaS > 0);
  const stallRatios = withMedia.map((record) => record.stallRatio ?? 0);
  const degradedViewers = stallRatios.filter((ratio) => ratio > DEGRADED_STALL_RATIO).length;
  const joinMs = records
    .filter((record) => record.joinMs !== undefined)
    .map((record) => record.joinMs as number);
  const liveViewers = records.filter((record) => record.live);

  // Percentiles of per-viewer percentiles are not percentiles of the whole
  // sample, so pool the raw p95s rather than pretending otherwise: this is the
  // p95 across viewers of each viewer's own p95, and the name says so.
  const realtimeP95s = records
    .map((record) => record.realtimeFactor.p95)
    .filter((value): value is number => value !== undefined);
  const fetchP95s = records
    .map((record) => record.fetchMs.p95)
    .filter((value): value is number => value !== undefined);

  const segments = sum(records.map((record) => record.segments));
  const bytes = sum(records.map((record) => record.bytes));
  const bodyFailures = sum(records.map((record) => record.bodyFailures));
  const streams = new Set(records.map((record) => `${record.owner}/${record.topic}`));

  return {
    viewers: {
      requested,
      started: records.length,
      joined: records.filter((record) => record.joined).length,
      watching: byOutcome.running,
      completed: byOutcome.completed,
      failed: byOutcome.crashed + byOutcome.never_joined,
      byOutcome,
    },
    degradedFraction: withMedia.length > 0 ? degradedViewers / withMedia.length : undefined,
    degradedViewers,
    stallRatio: distribution(stallRatios),
    stallFreeFraction:
      withMedia.length > 0
        ? stallRatios.filter((ratio) => ratio === 0).length / withMedia.length
        : undefined,
    joinSuccessRate:
      liveViewers.length > 0
        ? liveViewers.filter((record) => record.joined).length / liveViewers.length
        : undefined,
    joinMs: distribution(joinMs),
    realtimeFactorP95: quantile(realtimeP95s, 0.95),
    fetchMs: distribution(fetchP95s),
    segments,
    bytes,
    aggregateMbps: windowSeconds > 0 ? (bytes * 8) / windowSeconds / 1e6 : undefined,
    segmentsPerSecond: windowSeconds > 0 ? segments / windowSeconds : undefined,
    bodyFailureRate: segments + bodyFailures > 0 ? bodyFailures / (segments + bodyFailures) : undefined,
    secondStrikes: sum(records.map((record) => record.secondStrikes)),
    skippedTotal: sum(records.map((record) => record.skipped)),
    gapsLocal: sum(records.map((record) => record.gapsLocal)),
    gapsPublisher: sum(records.map((record) => record.gapsPublisher)),
    reconstructProbes: sum(records.map((record) => record.reconstructProbes)),
    dialFailures: sum(records.map((record) => record.dialFailures)),
    peersTotal: sum(records.map((record) => record.peersLast ?? 0)),
    peakRssTotalBytes: sum(records.map((record) => record.peakRssBytes ?? 0)),
    cpuSecondsTotal: sum(records.map((record) => record.cpuSeconds ?? 0)),
    distinctContentRatio: records.length > 0 ? streams.size / records.length : undefined,
    malformedLines: sum(records.map((record) => record.malformedLines)),
    unknownEvents: sum(records.map((record) => record.unknownEvents)),
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Bytes delivered over a trailing window, for the live console.
 *
 * The final report divides total bytes by total wall time; that is the right
 * number for a run and the wrong one for a display, because it flattens the
 * ramp into the steady state.
 */
export class ThroughputWindow {
  private readonly samples: { atMs: number; bytes: number }[] = [];

  constructor(private readonly windowMs: number) {}

  record(atMs: number, bytes: number): void {
    this.samples.push({ atMs, bytes });
    this.trim(atMs);
  }

  mbps(atMs: number): number {
    this.trim(atMs);
    if (this.samples.length === 0) {
      return 0;
    }
    const bytes = this.samples.reduce((total, sample) => total + sample.bytes, 0);
    const span = Math.max(this.windowMs, 1) / 1000;
    return (bytes * 8) / span / 1e6;
  }

  private trim(atMs: number): void {
    const cutoff = atMs - this.windowMs;
    while (this.samples.length > 0 && (this.samples[0] as { atMs: number }).atMs < cutoff) {
      this.samples.shift();
    }
  }
}
