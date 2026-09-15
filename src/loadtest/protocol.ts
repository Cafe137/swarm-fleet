/**
 * The contract between a participant's machine and the load-test backend.
 *
 * One publisher on a server, many people on their own laptops and home links,
 * all watching the same live stream and saying every 15 seconds what they are
 * doing. This module is the only description of what they say, and it lives
 * here rather than in the backend because the client is the thing that has to
 * be right on a stranger's machine: the backend depends on this package, so
 * there is one definition and a mismatch is a type error rather than a field
 * that silently reads `undefined` in the middle of a run.
 *
 * Two rules shape it:
 *
 * -   **Every field a client sends is optional except the ones that identify
 *     it.** A participant's laptop may not be able to measure its own network
 *     counters or CPU; the backend would rather have their viewer count than
 *     nothing at all.
 * -   **The server tells a client one thing: which stream to watch.** Everything
 *     else about the test is a constant below, shared by both sides. There was
 *     a version of this with server-controlled settings — peers per viewer, the
 *     scale step, the report interval — so the server could change the shape
 *     of the test mid-event. It bought nothing: those numbers are the viewer's
 *     own defaults and the figures the test was specified with, and the one
 *     case it was meant for, somebody's home router giving up, is answered
 *     better by the left arrow pressed by the person it is happening to.
 */

import { z } from 'zod';

/** Bumped when a field's meaning changes, so an old client can be told to update. */
export const LOADTEST_PROTOCOL_VERSION = 1;

export const StreamInfo = z.object({
  owner: z.string(),
  topic: z.string(),
  network: z.enum(['mainnet', 'testnet']).default('mainnet'),
  /** `live` is the only one a participant can watch; the others explain why not. */
  state: z.enum(['live', 'starting', 'stopped']).default('live'),
  /** Seconds of media published so far. A sanity check that it is really running. */
  mediaSeconds: z.number().nonnegative().optional(),
  title: z.string().optional(),
});
export type StreamInfo = z.infer<typeof StreamInfo>;

/**
 * The shape of the test, in one place, for both sides.
 *
 * Constants rather than configuration. Each one is either a figure the test was
 * specified with or the viewer's own default, and a participant is handed a
 * command with no flags — so there is nothing here for anyone to set, and one
 * definition that the client and the server cannot disagree about.
 */

/** Nodes a participant starts with, and what one arrow-key press is worth. */
export const START_VIEWERS = 20;
export const VIEWER_STEP = 20;

/**
 * Peer connections per viewer.
 *
 * 200 is the browser client's real footprint, which is why it is not a knob:
 * lowering it lowers the thing being measured. It is also the viewer binary's
 * own default, and it is passed explicitly so that a run's record says what it
 * asked for.
 */
export const PEERS_PER_VIEWER = 200;

/** Seconds between a participant's reports. */
export const REPORT_INTERVAL_S = 15;

/**
 * Where the client starts warning about home routers.
 *
 * A soft ceiling: it warns, and still lets people push. 100 nodes is 20,000
 * connections out of one house, well past what consumer hardware manages.
 */
export const WARN_ABOVE_VIEWERS = 100;

export const JoinRequest = z.object({
  protocol: z.number().int().default(LOADTEST_PROTOCOL_VERSION),
  /** A name kept from a previous run on this machine, to rejoin as. */
  sessionId: z.string().optional(),
  client: z.string().default('swarm-fleet'),
  platform: z.string().optional(),
  arch: z.string().optional(),
  cores: z.number().int().positive().optional(),
  memGb: z.number().positive().optional(),
  viewerSha256: z.string().optional(),
});
export type JoinRequest = z.infer<typeof JoinRequest>;

export const JoinResponse = z.object({
  sessionId: z.string(),
  /** The anonymous name shown on the leaderboard. Assigned by the server. */
  name: z.string(),
  stream: StreamInfo,
  serverTimeMs: z.number(),
  motd: z.string().optional(),
});
export type JoinResponse = z.infer<typeof JoinResponse>;

/**
 * One participant's 15-second postcard.
 *
 * Everything here is cheap to produce: the client already computes all of it
 * once a second for its own dashboard, so reporting costs a JSON encode.
 */
export const LoadtestReport = z.object({
  sessionId: z.string(),
  atMs: z.number(),
  /** Seconds since this participant's session began. */
  uptimeS: z.number().nonnegative(),
  viewers: z.number().int().nonnegative(),
  targetViewers: z.number().int().nonnegative(),
  bootstrapping: z.number().int().nonnegative().default(0),
  /** Media throughput over the last window, which is what the leaderboard ranks. */
  mediaMbps: z.number().nonnegative(),
  /** Interface throughput, when the machine will say. Swarm's real cost. */
  wireRxMbps: z.number().nonnegative().optional(),
  wireTxMbps: z.number().nonnegative().optional(),
  segments: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  stalls: z.number().int().nonnegative().default(0),
  degradedFraction: z.number().min(0).max(1).optional(),
  realtimeFactorP95: z.number().nonnegative().optional(),
  peersHeld: z.number().int().nonnegative().optional(),
  cpuUtilisation: z.number().min(0).max(1).optional(),
  memUsedFraction: z.number().min(0).max(1).optional(),
  /** Viewers that have ended since the session began, for any reason. */
  exited: z.number().int().nonnegative().default(0),
  /** Set once, on the last report, so the server can retire the row promptly. */
  leaving: z.boolean().default(false),
});
export type LoadtestReport = z.infer<typeof LoadtestReport>;

export const LeaderboardRow = z.object({
  name: z.string(),
  viewers: z.number().int().nonnegative(),
  peakViewers: z.number().int().nonnegative(),
  mediaMbps: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  segments: z.number().int().nonnegative(),
  degradedFraction: z.number().min(0).max(1).optional(),
  uptimeS: z.number().nonnegative(),
  /** Milliseconds since this participant last reported. Stale rows grey out. */
  ageMs: z.number().nonnegative(),
  online: z.boolean(),
});
export type LeaderboardRow = z.infer<typeof LeaderboardRow>;

export const FleetTotals = z.object({
  participants: z.number().int().nonnegative(),
  online: z.number().int().nonnegative(),
  viewers: z.number().int().nonnegative(),
  peakViewers: z.number().int().nonnegative(),
  mediaMbps: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  segments: z.number().int().nonnegative(),
});
export type FleetTotals = z.infer<typeof FleetTotals>;

export const ReportResponse = z.object({
  ok: z.literal(true),
  serverTimeMs: z.number(),
  stream: StreamInfo,
  totals: FleetTotals,
  /** Ranked by current media throughput, best first. */
  leaderboard: z.array(LeaderboardRow),
  /** This participant's position, 1-based. */
  rank: z.number().int().positive().optional(),
});
export type ReportResponse = z.infer<typeof ReportResponse>;

/** One instant of the whole event, which is what the web dashboard draws. */
export const LoadtestFrame = z.object({
  atMs: z.number(),
  totals: FleetTotals,
  leaderboard: z.array(LeaderboardRow),
  stream: StreamInfo.optional(),
});
export type LoadtestFrame = z.infer<typeof LoadtestFrame>;

export const HistoryResponse = z.object({
  fromMs: z.number(),
  toMs: z.number(),
  stepMs: z.number(),
  frames: z.array(LoadtestFrame),
});
export type HistoryResponse = z.infer<typeof HistoryResponse>;

/** Paths, in one place, so the client and the server cannot disagree. */
export const API = {
  join: '/api/join',
  stream: '/api/stream',
  report: '/api/report',
  leaderboard: '/api/leaderboard',
  history: '/api/history',
  events: '/api/events',
} as const;
