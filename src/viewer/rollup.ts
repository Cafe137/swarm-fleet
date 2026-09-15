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

/**
 * Media seconds the degraded judgement looks back over.
 *
 * `stalledS / mediaS` across a whole run answers the wrong question: at a 1%
 * threshold one 1.5 s hiccup brands a viewer degraded for the next 150 s of
 * clean playback, and in `--mode session` — which runs for hours — a bad
 * minute at the start would still be the headline at the end. The question
 * worth asking is whether a viewer is losing media time *now*.
 *
 * 60 s is two things at once: long enough that a single stalled 2 s segment
 * still shows (3.3%, comfortably over the threshold), and short enough that a
 * viewer which has recovered stops reading as degraded inside one minute —
 * four of the 15 s reports a participant sends home.
 *
 * The lifetime ratio is still kept and still reported; it is what
 * `stalled_out` is judged on, because that is a verdict on the whole run.
 */
export const TRAILING_STALL_WINDOW_S = 60;

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
  /** Lifetime `stalledS / mediaS`. A verdict on the whole run. */
  stallRatio?: number | undefined;
  /** `stalledS / mediaS` over the last `TRAILING_STALL_WINDOW_S` of media. */
  trailingStallRatio?: number | undefined;
  /** Media seconds the trailing ratio was computed over. */
  trailingMediaS?: number | undefined;
  /**
   * The viewer has fetched media but never filled its first buffer, so the
   * playhead never started. Not a stalling viewer — a viewer that never
   * watched anything, which a stall ratio of zero would otherwise flatter.
   */
  stuckPrerolling?: boolean | undefined;
  /** Seconds spent filling the first buffer. Absent if it never finished. */
  prerollS?: number | undefined;
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
  /** Peers held at the barrier, and how long the hold lasted. */
  heldAtPeers?: number | undefined;
  held?: boolean | undefined;
  releasedAtMs?: number | undefined;
  heldMs?: number | undefined;
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
  /** The trailing window: recent segments, oldest first, and its running sums. */
  private readonly window: { mediaS: number; stallS: number }[] = [];
  private windowMediaS = 0;
  private windowStallS = 0;
  /** The playhead has started at least once. */
  private started = false;
  private readonly record: ViewerRecord;

  constructor(identity: ViewerIdentity) {
    this.record = {
      ...identity,
      outcome: 'running',
      held: false,
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
      case 'held': {
        this.record.held = true;
        this.record.heldAtPeers = event.peers as number;
        this.record.peersLast = event.peers as number;
        this.record.peersMax = Math.max(this.record.peersMax ?? 0, event.peers as number);
        break;
      }
      case 'released': {
        this.record.held = false;
        this.record.heldMs = event.held_ms as number;
        this.record.peersLast = event.peers as number;
        this.record.peersMax = Math.max(this.record.peersMax ?? 0, event.peers as number);
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
        const stallS = event.stalled === true ? ((event.stall_s as number) ?? 0) : 0;
        if (event.stalled === true) {
          this.record.stalls += 1;
          this.record.stalledS += stallS;
          this.stallSamples.push(stallS);
        }
        this.pushWindow(segmentS, stallS);
        // Absent means playing: that is what viewers built before pre-roll was
        // separated from stalling reported, and their data must not change
        // meaning under a newer runner.
        if (event.playing !== false) {
          this.started = true;
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
        if (typeof event.preroll_s === 'number') {
          this.record.prerollS = event.preroll_s;
          this.started = true;
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Slide the trailing window forward by one segment.
   *
   * Trimmed by media seconds rather than by segment count, so a stream with
   * 10 s segments and one with 2 s segments are judged over the same amount of
   * playback. One segment always survives: a viewer that has produced any
   * media at all has a ratio.
   */
  private pushWindow(mediaS: number, stallS: number): void {
    this.window.push({ mediaS, stallS });
    this.windowMediaS += mediaS;
    this.windowStallS += stallS;
    while (
      this.window.length > 1 &&
      this.windowMediaS - (this.window[0] as { mediaS: number }).mediaS >= TRAILING_STALL_WINDOW_S
    ) {
      const dropped = this.window.shift() as { mediaS: number; stallS: number };
      this.windowMediaS -= dropped.mediaS;
      this.windowStallS -= dropped.stallS;
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
    record.trailingMediaS = this.windowMediaS > 0 ? this.windowMediaS : undefined;
    record.trailingStallRatio =
      this.windowMediaS > 0 ? this.windowStallS / this.windowMediaS : undefined;
    record.stuckPrerolling = record.mediaS > 0 && !this.started;
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
