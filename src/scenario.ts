/**
 * What a run is: the shape of the load, where it comes from, and when to stop.
 *
 * Resolved once, frozen, and written verbatim into `run.json`. A scenario that
 * cannot be read back out of the run directory is a run that cannot be
 * repeated, and an unrepeatable load measurement is an anecdote.
 */

import { z } from 'zod';
import { DEFAULT_ADMISSION } from './schedule.js';
import { PublisherConfig } from './publisher/config.js';
import { defined } from './util.js';
import { type AdmissionConfig, StreamRef, type ViewerSpec } from './transport/protocol.js';

export const AgentTarget = z.object({
  /** `local` runs an in-process agent; anything else is an SSH host. */
  host: z.string().default('local'),
  name: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().positive().optional(),
  identity: z.string().optional(),
  command: z.string().optional(),
  /** Set by `provision`: skip known_hosts on a box we created and will destroy. */
  ephemeralHost: z.boolean().optional(),
  /** Relative share of the fleet. Default 1, so machines split evenly. */
  weight: z.number().positive().default(1),
  maxViewers: z.number().int().positive().optional(),
});
export type AgentTarget = z.infer<typeof AgentTarget>;

export const StopCondition = z.object({
  /** Share of viewers losing more than 1% of media time to stalling. */
  degradedFraction: z.number().min(0).max(1).default(0.1),
  joinSuccessRate: z.number().min(0).max(1).default(0.95),
  /**
   * Share of viewers that must still hold their full peer footprint.
   *
   * The connection ceiling, and the reason `port-ceiling` can now find one. A
   * box behind a NAT holds a fixed total number of connections however many
   * viewers ask: measured at 64 viewers x 200 peers every viewer held all 200,
   * at 80 none of them did, and the fleet total stayed pinned either way. So
   * the ceiling does not announce itself as a stall or a failed dial — it shows
   * up as viewers quietly holding fewer peers than they were told to, and a
   * ramp that keeps climbing past it is adding processes, not load.
   *
   * Stopping here makes the last passing step the machine's real capacity.
   */
  peerAttainment: z.number().min(0).max(1).default(0.9),
  /** A breach must hold this long. One slow segment is not a cliff. */
  holdS: z.number().positive().default(30),
});
export type StopCondition = z.infer<typeof StopCondition>;

export const RampConfig = z.object({
  start: z.number().int().positive().default(10),
  step: z.number().int().positive().default(10),
  intervalS: z.number().positive().default(60),
  max: z.number().int().positive().default(200),
});
export type RampConfig = z.infer<typeof RampConfig>;

/**
 * The settle phase: peer the whole cohort, then start it watching together.
 *
 * Without it a run's ramp is inside its own measurement. Admission control
 * admits a viewer only while the box has CPU for another join, so a large
 * cohort takes a minute or more to be fully up — during which viewers that are
 * already retrieving share a thread with viewers still verifying certificate
 * chains, and `aggregateMbps` divides the run's bytes by a window that includes
 * the ramp. Settling separates the two: every viewer holds its full peer
 * footprint at the barrier, the publisher starts once they are all there, and
 * the barrier opens on all of them at once.
 *
 * `peerUp` defaults to the run's `peerLimit`, which is the point — a viewer
 * released while still dialing is the overlap this exists to remove.
 */
export const SettleConfig = z.object({
  /** Peers each viewer holds before it is released. Defaults to `peerLimit`. */
  peerUp: z.number().int().positive().optional(),
  /**
   * How long to wait for the cohort to settle before releasing it anyway.
   *
   * Releasing anyway rather than failing: a run that has 49 of 50 viewers
   * peered is still worth measuring, and the shortfall is recorded as a caveat
   * so nobody reads it as a clean cohort.
   */
  timeoutS: z.number().positive().default(300),
});
export type SettleConfig = z.infer<typeof SettleConfig>;

/**
 * `session` is the odd one out, and deliberately so.
 *
 * Every other mode describes a measurement that ends: a cohort watches for a
 * duration, a ramp climbs until something breaks. A session ends when a human
 * says so. It exists for a hand-driven run, where a participant starts
 * twenty viewers, then scales up and down by hand while a call is going on, and
 * the interesting number is what every machine generated together rather
 * than what any one laptop did.
 */
/**
 * The default ceiling for a hand-driven session.
 *
 * Far above what any laptop will manage — 1,000 viewers is ~35 GB of resident
 * memory and 200,000 sockets — which is the intent: the limit a participant
 * finds should be their machine's, not a number chosen here.
 */
export const SESSION_VIEWER_CEILING = 1_000;

export const MODES = ['cohort', 'ramp', 'soak', 'flood', 'port-ceiling', 'session'] as const;
export type Mode = (typeof MODES)[number];

export const Scenario = z
  .object({
    mode: z.enum(MODES),
    label: z.string().optional(),
    viewers: z.number().int().positive().optional(),
    durationS: z.number().positive().optional(),
    segments: z.number().int().positive().optional(),
    ramp: RampConfig.partial().optional(),
    /** Peer the whole cohort before any of it starts watching. */
    settle: z.union([z.boolean(), SettleConfig.partial()]).optional(),
    stop: StopCondition.partial().optional(),
    /**
     * Empty is legal only alongside `publisher`, which supplies the stream it
     * creates. `resolveScenario` refuses a run that would have nothing to watch.
     */
    streams: z.array(StreamRef).default([]),
    /** Start a live publisher for this run, and point the viewers at it. */
    publisher: PublisherConfig.partial().optional(),
    assignment: z.enum(['all', 'round-robin']).default('all'),
    network: z.enum(['mainnet', 'testnet']).default('mainnet'),
    live: z.boolean().default(true),
    peerLimit: z.number().int().positive().default(200),
    /**
     * Connections per second each viewer may open, or 0 for the unpaced burst.
     *
     * Left unset the viewer picks its own default. It is a fleet lever because
     * the join is the only part of a viewer's life that costs a whole core, and
     * on a box packed with viewers the peak is what breaches `cpu_headroom`.
     */
    dialRate: z.number().int().nonnegative().optional(),
    /**
     * Verify every retrieved chunk against its content address.
     *
     * Off by default, matching the viewer. It is 8.3% of a viewer's CPU on
     * x86, so leaving it off is how a run gets the density the rig is for —
     * but it means the run's CPU figures are below a real browser client's,
     * and a peer sending well-formed wrong bytes would not have been caught.
     * Every run says which way it ran.
     */
    verifyChunks: z.boolean().default(false),
    binary: z.string().default('../weeb-3-rs-hls/target/release/weeb-3-rs-hls'),
    agents: z.array(AgentTarget).default([{ host: 'local', weight: 1 }]),
    admission: z
      .object({
        bootstrapVcpu: z.number().positive(),
        steadyVcpu: z.number().positive(),
        targetUtilisation: z.number().positive(),
        minStartIntervalMs: z.number().nonnegative(),
        startJitterMs: z.number().nonnegative(),
        bootstrapTimeoutMs: z.number().positive(),
      })
      .partial()
      .optional(),
    sampleIntervalMs: z.number().positive().default(1_000),
    countSockets: z.boolean().optional(),
    /** How long a viewer gets to finish and report after SIGTERM. */
    graceMs: z.number().nonnegative().default(15_000),
    /** Hard ceiling on the whole run, whatever the mode wants. */
    maxRunS: z.number().positive().optional(),
    /** Seconds past its own duration before a viewer counts as hung. */
    stragglerGraceS: z.number().positive().optional(),
    /** `flood` refuses to run without this. */
    acknowledgeFlood: z.boolean().default(false),
    /**
     * How far a session may be scaled up by hand.
     *
     * Not a policy about what is sensible — a participant in a hand-driven run
     * is *supposed* to push their machine until something gives, and finding
     * that point is half the value. It is a bound on the arithmetic: the
     * partition, the start budgets and the clamp all need a finite number, and
     * a laptop runs out of memory long before a thousand viewers.
     */
    viewerCeiling: z.number().int().positive().optional(),
    /**
     * Whose machine this is, and therefore what preflight's refusals mean.
     *
     * `rig` is a machine rented to produce a capacity number. `participant` is
     * a machine somebody uses for other things, where every check is
     * advisory: refusing to run there costs the test viewers and protects a
     * measurement nobody was going to publish. See `agent/preflight.ts`.
     */
    profile: z.enum(['rig', 'participant']).default('rig'),
    runsDir: z.string().default('runs'),
    env: z.record(z.string()).default({}),
    extraArgs: z.array(z.string()).default([]),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

export interface ResolvedScenario {
  mode: Mode;
  label: string;
  /** Viewers this run starts with, and what preflight is sized against. */
  peakViewers: number;
  /**
   * The most viewers this run may ever hold.
   *
   * The same as `peakViewers` everywhere except a session, where the target is
   * a person's arrow keys rather than a plan, so the two genuinely differ:
   * preflight should judge the twenty viewers about to start, and the clamp
   * should let them reach whatever their machine can stand.
   */
  viewerCeiling: number;
  ramp: RampConfig | undefined;
  /** Set when the cohort peers and waits before it watches. */
  settle: (SettleConfig & { peerUp: number }) | undefined;
  stop: StopCondition;
  durationS: number | undefined;
  maxRunS: number;
  stragglerGraceS: number;
  spec: ViewerSpec;
  admission: AdmissionConfig;
  agents: AgentTarget[];
  sampleIntervalMs: number;
  countSockets: boolean;
  graceMs: number;
  profile: 'rig' | 'participant';
  runsDir: string;
  /** Set when this run publishes its own stream. */
  publisher: PublisherConfig | undefined;
  /**
   * Reasons, derivable from the scenario alone, that a number here may not mean
   * what it appears to. The controller reports these alongside the ones it
   * observes during the run.
   */
  caveats: string[];
  /** False when the scenario deliberately breaks a measurement rule. */
  comparable: boolean;
  incomparableBecause: string | undefined;
  raw: Scenario;
}

export function resolveScenario(input: unknown): ResolvedScenario {
  const scenario = Scenario.parse(input);

  const ramp =
    scenario.mode === 'ramp' || scenario.mode === 'port-ceiling'
      ? RampConfig.parse(scenario.ramp ?? {})
      : undefined;
  const viewers = scenario.viewers ?? ramp?.max ?? 10;
  const peakViewers = ramp === undefined ? viewers : ramp.max;

  if (scenario.mode === 'flood' && !scenario.acknowledgeFlood) {
    throw new Error(
      'flood disables admission control, so every join-latency number from the run is ' +
        'unusable and the run is not comparable with any other. Pass --acknowledge-flood ' +
        'if that is what you want to measure.',
    );
  }

  const admission: AdmissionConfig = {
    ...DEFAULT_ADMISSION,
    ...defined(scenario.admission ?? {}),
    disabled: scenario.mode === 'flood',
  };

  // A cohort with no bound would never end. Segments or a duration must exist,
  // and a duration is the one the fleet can hold every viewer to.
  const durationS =
    scenario.durationS ?? (scenario.segments === undefined ? defaultDuration(scenario.mode) : undefined);

  if (scenario.streams.length === 0) {
    throw new Error(
      'no stream to watch: pass --stream <owner>:<topic>, or --owner and --topic, or ' +
        '--publish to make one, or name them in a --scenario file',
    );
  }

  const publisher =
    scenario.publisher === undefined ? undefined : PublisherConfig.parse(scenario.publisher);
  const caveats: string[] = [];
  if (!scenario.verifyChunks) {
    caveats.push(
      'chunk content verification was off (--unsafe, the viewer default), so viewer CPU here ' +
        'is 8.3% below what a real browser client pays — measured on 6-core x86 over eight ' +
        'interleaved pairs, 0.1268 against 0.1382 CPU-seconds per MB. Density figures from ' +
        'this run are therefore optimistic by about that much, and a peer returning ' +
        'well-formed wrong bytes would not have been detected. Pass --verify to measure what ' +
        'a real viewer costs.',
    );
  }
  if (publisher !== undefined && scenario.agents.some((agent) => agent.host === 'local')) {
    caveats.push(
      'the publisher ran on a machine that also hosted viewers. Encoding video costs ' +
        'several cores — 4.2 of 8 measured at 1120x700 and 30fps — so that machine was not ' +
        'idle and its viewers competed with ffmpeg for CPU. Put the publisher on a machine ' +
        'with no agent before believing any stall or join figure from this run.',
    );
  }

  // A ramp adds viewers on purpose while the run is measuring, so there is no
  // moment when the cohort is "all there" to release. Refusing is better than
  // quietly settling the first step and calling it a ramp.
  if (scenario.mode === 'session' && scenario.ramp !== undefined) {
    throw new Error(
      'a session is driven by hand, so a ramp has nothing to drive: the target changes when ' +
        'someone presses a key. Use --mode ramp for a scripted climb.',
    );
  }

  const settleRequested = scenario.settle !== undefined && scenario.settle !== false;
  if (settleRequested && scenario.mode === 'session') {
    throw new Error(
      'settle and session are alternatives: settling releases a complete cohort at one instant, ' +
        'and a session never has a complete cohort — that is what the arrow keys are for.',
    );
  }
  if (settleRequested && ramp !== undefined) {
    throw new Error(
      'settle and ramp are alternatives: a ramp deliberately starts viewers during the ' +
        'measurement, so there is no point at which the cohort is complete and can be ' +
        'released together. Use --mode cohort to settle, or drop --settle to ramp.',
    );
  }
  const settle = settleRequested
    ? (() => {
        const parsed = SettleConfig.parse(scenario.settle === true ? {} : scenario.settle);
        return { ...parsed, peerUp: parsed.peerUp ?? scenario.peerLimit };
      })()
    : undefined;

  const spec: ViewerSpec = {
    binary: scenario.binary,
    network: scenario.network,
    live: scenario.live,
    peerLimit: scenario.peerLimit,
    ...(scenario.dialRate === undefined ? {} : { dialRate: scenario.dialRate }),
    streams: scenario.streams,
    assignment: scenario.assignment,
    env: scenario.env,
    extraArgs: scenario.extraArgs,
    hold: settle !== undefined,
    verifyChunks: scenario.verifyChunks,
    ...(settle === undefined ? {} : { peerUp: settle.peerUp }),
    ...(durationS === undefined ? {} : { durationS }),
    ...(scenario.segments === undefined ? {} : { segments: scenario.segments }),
  };

  const rampTotalS =
    ramp === undefined
      ? 0
      : (Math.ceil((ramp.max - ramp.start) / ramp.step) + 1) * ramp.intervalS;
  // The settle phase is not part of the run's ceiling: a cohort that took two
  // minutes to peer must still get its full duration afterwards.
  const settleS = settle === undefined ? 0 : settle.timeoutS;
  const maxRunS =
    scenario.maxRunS ??
    (scenario.mode === 'session'
      ? // Long enough that a session ends when someone ends it, short enough
        // that a forgotten terminal does not hold mainnet connections all week.
        12 * 3_600
      : ramp === undefined
        ? (durationS ?? 600) + 300 + settleS
        : rampTotalS + 300);

  return {
    mode: scenario.mode,
    label: scenario.label ?? `${scenario.mode}-${peakViewers}`,
    peakViewers,
    viewerCeiling:
      scenario.viewerCeiling ?? (scenario.mode === 'session' ? SESSION_VIEWER_CEILING : peakViewers),
    ramp,
    settle,
    stop: StopCondition.parse(scenario.stop ?? {}),
    durationS,
    maxRunS,
    /**
     * 30 s past a viewer's own duration is hung, not slow.
     *
     * A duration-bounded viewer ends itself, so the only question is how long
     * to indulge one that has not. Held down deliberately: the alternative is
     * `maxRunS`, which for a 120 s run is 720 s, and waiting that out is what
     * cost the first Vultr fleet run every record it had collected.
     */
    stragglerGraceS: scenario.stragglerGraceS ?? 30,
    spec,
    admission,
    agents: scenario.agents,
    sampleIntervalMs: scenario.sampleIntervalMs,
    countSockets: scenario.countSockets ?? scenario.mode === 'port-ceiling',
    profile: scenario.profile,
    graceMs: scenario.graceMs,
    runsDir: scenario.runsDir,
    publisher,
    caveats,
    comparable: scenario.mode !== 'flood',
    incomparableBecause:
      scenario.mode === 'flood'
        ? 'admission control disabled: joins were CPU-starved by design'
        : undefined,
    raw: scenario,
  };
}

function defaultDuration(mode: Mode): number {
  switch (mode) {
    case 'soak':
      return 3_600;
    case 'flood':
      return 120;
    // A session's viewers are replaced when they end, so this is not how long
    // the session lasts — it is how long one viewer lives before it is retired
    // and a fresh one takes its place. An hour is long enough that nobody sees
    // it happen mid-run, and short enough that a viewer which has quietly
    // stopped retrieving does not sit there for the whole event.
    case 'session':
      return 3_600;
    default:
      return 300;
  }
}
