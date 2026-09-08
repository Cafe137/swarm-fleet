/**
 * One viewer's event stream, folded into one record.
 *
 * The fold is incremental because the controller shows live KPIs while the run
 * is going, and because a viewer that dies without a `summary` must still yield
 * everything it managed to report. `summary` is authoritative where it exists —
 * the viewer counted its own stalls against its own clock, and re-deriving them
 * out here would be a second implementation of the thing being measured.
 */

import type { ViewerEvent } from './contract.js';
import { type Distribution, distribution, max, min } from '../metrics/percentile.js';

/** Above this share of media time lost to stalling, a viewer had a bad time. */
export const DEGRADED_STALL_RATIO = 0.01;
/** Above this, playback was not really watchable at all. */
export const STALLED_OUT_RATIO = 0.25;

export type ViewerOutcome =
  | 'running'
  | 'completed'
  | 'stalled_out'
  | 'crashed'
  | 'killed'
  | 'never_joined';

export interface ViewerExit {
  code: number | null;
  signal: string | null;
  /** True when the runner asked for this exit, so a signal is not a crash. */
  requested: boolean;
}

export interface ViewerRecord {
  viewerId: string;
  agent: string;
  owner: string;
  topic: string;
  peerLimit: number;
  live: boolean;
  /** Controller wall clock, so records from different machines line up. */
  startedAtMs: number;
  exitedAtMs?: number | undefined;
  pid?: number | undefined;
  outcome: ViewerOutcome;
  exit?: ViewerExit | undefined;

  joined: boolean;
  joinMs?: number | undefined;
  runwayS?: number | undefined;

  segments: number;
  bytes: number;
  mediaS: number;
  wallS: number;
  stalls: number;
  stalledS: number;
  longestStallS?: number | undefined;
  stallRatio?: number | undefined;
  fetchMs: Distribution;
  /** fetch_ms / (segment_s * 1000). Above 1 the viewer is losing buffer. */
  realtimeFactor: Distribution;
  minBufferedS?: number | undefined;

  bodyFailures: number;
  secondStrikes: number;
  skipped: number;
  gapsPublisher: number;
  gapsLocal: number;
  reconstructProbes: number;
  reconstructRuns: number;

  peersLast?: number | undefined;
  peersMax?: number | undefined;
  dialFailures: number;
  feedIndexLast?: number | undefined;
  finalized: boolean;

  /** Filled by the agent's sampler, not by the viewer. */
  peakRssBytes?: number | undefined;
  cpuSeconds?: number | undefined;

  events: number;
  unknownEvents: number;
  malformedLines: number;
  errors: { stage: string; message: string }[];
  summarySeen: boolean;
}

export interface ViewerIdentity {
  viewerId: string;
  agent: string;
  owner: string;
  topic: string;
  peerLimit: number;
  live: boolean;
  startedAtMs: number;
}

/** Incremental fold over one viewer's events. */
export class ViewerRollup {
  private readonly fetchSamples: number[] = [];
  private readonly realtimeSamples: number[] = [];
  private readonly stallSamples: number[] = [];
  private readonly bufferedSamples: number[] = [];
  private readonly record: ViewerRecord;

  constructor(identity: ViewerIdentity) {
    this.record = {
      ...identity,
      outcome: 'running',
      joined: false,
      segments: 0,
      bytes: 0,
      mediaS: 0,
      wallS: 0,
      stalls: 0,
      stalledS: 0,
      fetchMs: distribution([]),
      realtimeFactor: distribution([]),
      bodyFailures: 0,
      secondStrikes: 0,
      skipped: 0,
      gapsPublisher: 0,
      gapsLocal: 0,
      reconstructProbes: 0,
      reconstructRuns: 0,
      dialFailures: 0,
      finalized: false,
      events: 0,
      unknownEvents: 0,
      malformedLines: 0,
      errors: [],
      summarySeen: false,
    };
  }

  get viewerId(): string {
    return this.record.viewerId;
  }

  get joinedLiveEdge(): boolean {
    return this.record.joined;
  }

  get sawSegments(): boolean {
    return this.record.segments > 0;
  }

  noteMalformed(): void {
    this.record.malformedLines += 1;
  }

  noteUnknown(): void {
    this.record.unknownEvents += 1;
  }

  /** Sampler output, which the viewer does not know about. */
  noteResource(rssBytes: number, cpuSeconds: number): void {
    this.record.peakRssBytes = Math.max(this.record.peakRssBytes ?? 0, rssBytes);
    this.record.cpuSeconds = Math.max(this.record.cpuSeconds ?? 0, cpuSeconds);
  }

  apply(event: ViewerEvent): void {
    this.record.events += 1;
    switch (event.ev) {
      case 'start': {
        this.record.pid = event.pid as number;
        break;
      }
      case 'peers': {
        const peers = event.peers as number;
        this.record.peersLast = peers;
        this.record.peersMax = Math.max(this.record.peersMax ?? 0, peers);
        this.record.dialFailures = Math.max(
          this.record.dialFailures,
          (event.dial_failures as number) ?? 0,
        );
        break;
      }
      case 'joined': {
        this.record.joined = true;
        this.record.joinMs = event.join_ms as number;
        this.record.runwayS = event.runway_s as number;
        this.record.feedIndexLast = event.feed_index as number;
        break;
      }
      case 'segment': {
        const fetchMs = event.fetch_ms as number;
        const segmentS = event.segment_s as number;
        this.record.segments += 1;
        this.record.bytes += event.bytes as number;
        this.record.mediaS += segmentS;
        this.record.wallS = (event.t as number) / 1000;
        this.fetchSamples.push(fetchMs);
        this.realtimeSamples.push(fetchMs / (segmentS * 1000));
        this.bufferedSamples.push(event.buffered_s as number);
        if (event.stalled === true) {
          this.record.stalls += 1;
          const stallS = (event.stall_s as number) ?? 0;
          this.record.stalledS += stallS;
          this.stallSamples.push(stallS);
        }
        if (typeof event.peers === 'number') {
          this.record.peersLast = event.peers;
          this.record.peersMax = Math.max(this.record.peersMax ?? 0, event.peers);
        }
        if (typeof event.feed_index === 'number') {
          this.record.feedIndexLast = event.feed_index;
        }
        break;
      }
      case 'body_failure': {
        this.record.bodyFailures += 1;
        if (event.strike === 2) {
          this.record.secondStrikes += 1;
        }
        break;
      }
      case 'gap': {
        if (event.source === 'local') {
          this.record.gapsLocal += 1;
        } else {
          this.record.gapsPublisher += 1;
        }
        break;
      }
      case 'skip': {
        this.record.skipped += Math.max(1, (event.to as number) - (event.from as number));
        break;
      }
      case 'reconstruct': {
        this.record.reconstructRuns += 1;
        this.record.reconstructProbes += event.probes as number;
        break;
      }
      case 'error': {
        this.record.errors.push({
          stage: event.stage as string,
          message: event.message as string,
        });
        break;
      }
      case 'summary': {
        // Authoritative: the viewer measured these against its own clock.
        this.record.summarySeen = true;
        this.record.segments = event.segments as number;
        this.record.bytes = event.bytes as number;
        this.record.mediaS = event.media_s as number;
        this.record.wallS = event.wall_s as number;
        this.record.stalls = event.stalls as number;
        this.record.stalledS = event.stalled_s as number;
        this.record.skipped = event.skipped as number;
        this.record.bodyFailures = Math.max(
          this.record.bodyFailures,
          event.body_failures as number,
        );
        this.record.finalized = event.finalized === true;
        if (typeof event.join_ms === 'number') {
          this.record.joinMs = event.join_ms;
        }
        if (typeof event.feed_index === 'number') {
          this.record.feedIndexLast = event.feed_index;
        }
        if (typeof event.peers === 'number') {
          this.record.peersLast = event.peers;
        }
        if (typeof event.peak_rss === 'number') {
          this.record.peakRssBytes = Math.max(this.record.peakRssBytes ?? 0, event.peak_rss);
        }
        break;
      }
      default:
        break;
    }
  }

  noteExit(exit: ViewerExit, atMs: number): void {
    this.record.exit = exit;
    this.record.exitedAtMs = atMs;
  }

  /** Snapshot with the derived fields computed. Safe to call mid-run. */
  finish(): ViewerRecord {
    const record = { ...this.record };
    record.fetchMs = distribution(this.fetchSamples);
    record.realtimeFactor = distribution(this.realtimeSamples);
    record.longestStallS = max(this.stallSamples);
    record.minBufferedS = min(this.bufferedSamples);
    record.stallRatio = record.mediaS > 0 ? record.stalledS / record.mediaS : undefined;
    record.errors = [...this.record.errors];
    record.outcome = classify(record);
    return record;
  }
}

function classify(record: ViewerRecord): ViewerOutcome {
  const exit = record.exit;
  if (exit === undefined) {
    return 'running';
  }
  // A signal we sent is not a crash; a signal we did not send is.
  const crashed = exit.requested
    ? false
    : exit.signal !== null || (exit.code !== null && exit.code !== 0);
  if (crashed) {
    return 'crashed';
  }
  if (record.live && !record.joined) {
    return 'never_joined';
  }
  if ((record.stallRatio ?? 0) >= STALLED_OUT_RATIO) {
    return 'stalled_out';
  }
  // `killed` is not a failure: it is a viewer the runner stopped rather than
  // one that reached its own `--segments` or `--duration` bound. Whether it
  // still managed to report its summary is `summarySeen`.
  return exit.requested ? 'killed' : 'completed';
}
