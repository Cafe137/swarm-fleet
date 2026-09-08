/**
 * The viewer event contract: what `weeb-3-rs-hls --metrics json` writes to
 * stdout, one JSON object per line.
 *
 * This module is the interface with Rust, so it is deliberately lenient in one
 * direction and strict in the other. Fields the runner needs are validated;
 * unknown fields pass through, and an unknown `ev` is *counted*, not fatal —
 * otherwise adding an event on the Rust side would break every runner in the
 * fleet mid-run. Malformed lines are counted too, for the same reason: a viewer
 * that interleaves a stray write on stdout should cost us one line, not a run.
 */

import { z } from 'zod';

export const VIEWER_MODES = ['live', 'vod', 'peer'] as const;
export type ViewerMode = (typeof VIEWER_MODES)[number];

/** `t` is milliseconds since the viewer process started, not wall clock. */
const stamped = { t: z.number().nonnegative() };

export const StartEvent = z
  .object({
    ...stamped,
    ev: z.literal('start'),
    pid: z.number().int().positive(),
    network_id: z.number().int(),
    mode: z.enum(VIEWER_MODES),
    owner: z.string().optional(),
    topic: z.string().optional(),
    peer_limit: z.number().int().positive().optional(),
    version: z.string().optional(),
    git_sha: z.string().optional(),
  })
  .passthrough();

export const PeersEvent = z
  .object({
    ...stamped,
    ev: z.literal('peers'),
    peers: z.number().int().nonnegative(),
    dial_failures: z.number().int().nonnegative().default(0),
  })
  .passthrough();

export const JoinedEvent = z
  .object({
    ...stamped,
    ev: z.literal('joined'),
    join_ms: z.number().nonnegative(),
    feed_index: z.number().int().nonnegative(),
    edge_sequence: z.number().int().nonnegative().nullish(),
    start_sequence: z.number().int().nonnegative(),
    runway_s: z.number().nonnegative(),
    window: z.number().int().nonnegative(),
  })
  .passthrough();

export const SegmentEvent = z
  .object({
    ...stamped,
    ev: z.literal('segment'),
    sequence: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    fetch_ms: z.number().nonnegative(),
    segment_s: z.number().positive(),
    buffered_s: z.number(),
    stalled: z.boolean().default(false),
    /** Seconds the playhead was dry before this segment landed. */
    stall_s: z.number().nonnegative().default(0),
    feed_index: z.number().int().nonnegative().optional(),
    attempts: z.number().int().positive().default(1),
    peers: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const BodyFailureEvent = z
  .object({
    ...stamped,
    ev: z.literal('body_failure'),
    sequence: z.number().int().nonnegative(),
    /** 1 = asking again, 2 = written off as a gap. */
    strike: z.number().int().min(1).max(2),
    attempts: z.number().int().nonnegative().default(0),
  })
  .passthrough();

export const GapEvent = z
  .object({
    ...stamped,
    ev: z.literal('gap'),
    sequence: z.number().int().nonnegative(),
    /** `publisher` = an EXT-X-GAP we were told about; `local` = our own failure. */
    source: z.enum(['publisher', 'local']),
  })
  .passthrough();

export const SkipEvent = z
  .object({
    ...stamped,
    ev: z.literal('skip'),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    reason: z.string().default('fell off the live window'),
  })
  .passthrough();

export const ReconstructEvent = z
  .object({
    ...stamped,
    ev: z.literal('reconstruct'),
    probes: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    ms: z.number().nonnegative(),
  })
  .passthrough();

export const SummaryEvent = z
  .object({
    ...stamped,
    ev: z.literal('summary'),
    segments: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    media_s: z.number().nonnegative().default(0),
    wall_s: z.number().nonnegative().default(0),
    stalls: z.number().int().nonnegative().default(0),
    stalled_s: z.number().nonnegative().default(0),
    skipped: z.number().int().nonnegative().default(0),
    gaps: z.number().int().nonnegative().default(0),
    body_failures: z.number().int().nonnegative().default(0),
    fetch_ms_p50: z.number().nonnegative().optional(),
    fetch_ms_p90: z.number().nonnegative().optional(),
    fetch_ms_p99: z.number().nonnegative().optional(),
    peers: z.number().int().nonnegative().optional(),
    join_ms: z.number().nonnegative().optional(),
    feed_index: z.number().int().nonnegative().optional(),
    finalized: z.boolean().default(false),
    peak_rss: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const ErrorEvent = z
  .object({
    ...stamped,
    ev: z.literal('error'),
    stage: z.string(),
    message: z.string(),
  })
  .passthrough();

/** An `ev` this build does not know. Counted, kept, never fatal. */
export const UnknownEvent = z.object({ ...stamped, ev: z.string() }).passthrough();

export const ViewerEvent = z.union([
  StartEvent,
  PeersEvent,
  JoinedEvent,
  SegmentEvent,
  BodyFailureEvent,
  GapEvent,
  SkipEvent,
  ReconstructEvent,
  SummaryEvent,
  ErrorEvent,
  UnknownEvent,
]);

export type StartEvent = z.infer<typeof StartEvent>;
export type PeersEvent = z.infer<typeof PeersEvent>;
export type JoinedEvent = z.infer<typeof JoinedEvent>;
export type SegmentEvent = z.infer<typeof SegmentEvent>;
export type BodyFailureEvent = z.infer<typeof BodyFailureEvent>;
export type GapEvent = z.infer<typeof GapEvent>;
export type SkipEvent = z.infer<typeof SkipEvent>;
export type ReconstructEvent = z.infer<typeof ReconstructEvent>;
export type SummaryEvent = z.infer<typeof SummaryEvent>;
export type ErrorEvent = z.infer<typeof ErrorEvent>;
export type ViewerEvent = z.infer<typeof ViewerEvent>;

export type ParseResult =
  | { ok: true; event: ViewerEvent; known: boolean }
  | { ok: false; reason: string };

const KNOWN_EVENTS = new Set([
  'start',
  'peers',
  'joined',
  'segment',
  'body_failure',
  'gap',
  'skip',
  'reconstruct',
  'summary',
  'error',
]);

/**
 * Parse one stdout line. Never throws: a bad line is a datum about the viewer,
 * not an exception for the runner.
 */
export function parseViewerEvent(line: string): ParseResult {
  const text = line.trim();
  if (text.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not json' };
  }
  const parsed = ViewerEvent.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'schema' };
  }
  return { ok: true, event: parsed.data, known: KNOWN_EVENTS.has(parsed.data.ev) };
}
