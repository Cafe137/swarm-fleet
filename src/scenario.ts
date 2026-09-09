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
  /** Relative share of the fleet. Default 1, so machines split evenly. */
  weight: z.number().positive().default(1),
  maxViewers: z.number().int().positive().optional(),
});
export type AgentTarget = z.infer<typeof AgentTarget>;

export const StopCondition = z.object({
  /** Share of viewers losing more than 1% of media time to stalling. */
  degradedFraction: z.number().min(0).max(1).default(0.1),
  joinSuccessRate: z.number().min(0).max(1).default(0.95),
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

export const MODES = ['cohort', 'ramp', 'soak', 'flood', 'port-ceiling'] as const;
export type Mode = (typeof MODES)[number];

export const Scenario = z
  .object({
    mode: z.enum(MODES),
    label: z.string().optional(),
    viewers: z.number().int().positive().optional(),
    durationS: z.number().positive().optional(),
    segments: z.number().int().positive().optional(),
    ramp: RampConfig.partial().optional(),
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
    /** `flood` refuses to run without this. */
    acknowledgeFlood: z.boolean().default(false),
    runsDir: z.string().default('runs'),
    env: z.record(z.string()).default({}),
    extraArgs: z.array(z.string()).default([]),
  })
  .strict();
export type Scenario = z.infer<typeof Scenario>;

export interface ResolvedScenario {
  mode: Mode;
  label: string;
  /** Peak viewers this run will ever ask for. Sizes preflight. */
  peakViewers: number;
  ramp: RampConfig | undefined;
  stop: StopCondition;
  durationS: number | undefined;
  maxRunS: number;
  spec: ViewerSpec;
  admission: AdmissionConfig;
  agents: AgentTarget[];
  sampleIntervalMs: number;
  countSockets: boolean;
  graceMs: number;
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
  if (publisher !== undefined && scenario.agents.some((agent) => agent.host === 'local')) {
    caveats.push(
      'the publisher ran on a machine that also hosted viewers. Encoding video costs ' +
        'several cores — 4.2 of 8 measured at 1120x700 and 30fps — so that machine was not ' +
        'idle and its viewers competed with ffmpeg for CPU. Put the publisher on a machine ' +
        'with no agent before believing any stall or join figure from this run.',
    );
  }

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
    ...(durationS === undefined ? {} : { durationS }),
    ...(scenario.segments === undefined ? {} : { segments: scenario.segments }),
  };

  const rampTotalS =
    ramp === undefined
      ? 0
      : (Math.ceil((ramp.max - ramp.start) / ramp.step) + 1) * ramp.intervalS;
  const maxRunS =
    scenario.maxRunS ?? (ramp === undefined ? (durationS ?? 600) + 300 : rampTotalS + 300);

  return {
    mode: scenario.mode,
    label: scenario.label ?? `${scenario.mode}-${peakViewers}`,
    peakViewers,
    ramp,
    stop: StopCondition.parse(scenario.stop ?? {}),
    durationS,
    maxRunS,
    spec,
    admission,
    agents: scenario.agents,
    sampleIntervalMs: scenario.sampleIntervalMs,
    countSockets: scenario.countSockets ?? scenario.mode === 'port-ceiling',
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
    default:
      return 300;
  }
}
