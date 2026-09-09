/**
 * The control plane: newline-delimited JSON in both directions.
 *
 * Deliberately small. Agents forward raw viewer lines rather than parsed
 * events, so the contract in `viewer/contract.ts` has exactly one
 * implementation and it lives on the controller; an agent that understood the
 * event schema would be a second place to keep it up to date.
 *
 * Raw event files and viewer stderr stay on the agent's disk during a run and
 * are collected at the end. Only events cross the wire live, which at 200
 * viewers on 2 s segments is ~100 messages a second per machine.
 */

import { z } from 'zod';

export const MachineInfo = z.object({
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  cores: z.number().int().positive(),
  totalMemBytes: z.number().int().positive(),
  nodeVersion: z.string(),
  cpuModel: z.string().optional(),
  portRangeFirst: z.number().int().optional(),
  portRangeLast: z.number().int().optional(),
  fileDescriptorLimit: z.number().int().optional(),
});
export type MachineInfo = z.infer<typeof MachineInfo>;

export const PreflightCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  /** A failed fatal check refuses the run; a failed advisory check is recorded. */
  fatal: z.boolean(),
  value: z.string().optional(),
  detail: z.string(),
});
export type PreflightCheck = z.infer<typeof PreflightCheck>;

export const PreflightReport = z.object({
  ok: z.boolean(),
  checks: z.array(PreflightCheck),
  binarySha256: z.string().optional(),
  binaryPath: z.string().optional(),
  weeb3GitSha: z.string().optional(),
});
export type PreflightReport = z.infer<typeof PreflightReport>;

export const MachineSample = z.object({
  atMs: z.number(),
  loadAvg1: z.number(),
  loadAvg5: z.number(),
  freeMemBytes: z.number(),
  agentRssBytes: z.number(),
  establishedSockets: z.number().int().optional(),
  /** How late this sample was against its 1 Hz nominal. A starved agent shows here. */
  samplerLagMs: z.number(),
  viewerRssTotalBytes: z.number(),
  /**
   * Machine-wide CPU busy fraction over the sample interval, 0-1.
   *
   * Load average is what the guards judge, because a saturated box is what it
   * describes, but it is a one-minute average and lags a ramp step by a minute.
   * This is what a human watching the ramp needs.
   */
  cpuUtilisation: z.number().optional(),
  /** Sum of the per-viewer CPU deltas, in vCPU. The load the fleet itself costs. */
  viewerVcpuTotal: z.number().optional(),
  /** Cumulative non-loopback interface counters, and the rate since the last sample. */
  rxBytes: z.number().optional(),
  txBytes: z.number().optional(),
  rxBytesPerSec: z.number().optional(),
  txBytesPerSec: z.number().optional(),
});
export type MachineSample = z.infer<typeof MachineSample>;

export const ViewerSample = z.object({
  viewerId: z.string(),
  rssBytes: z.number(),
  cpuSeconds: z.number(),
});
export type ViewerSample = z.infer<typeof ViewerSample>;

export const StreamRef = z.object({ owner: z.string(), topic: z.string() });
export type StreamRef = z.infer<typeof StreamRef>;

export const ViewerSpec = z.object({
  /** Path to `weeb-3-rs-hls`, or the sentinel `mock` for the built-in fake. */
  binary: z.string(),
  network: z.enum(['mainnet', 'testnet']),
  live: z.boolean(),
  peerLimit: z.number().int().positive().optional(),
  /** Connections per second a viewer may open. 0 is the unpaced burst. */
  dialRate: z.number().int().nonnegative().optional(),
  durationS: z.number().positive().optional(),
  segments: z.number().int().positive().optional(),
  streams: z.array(StreamRef).min(1),
  assignment: z.enum(['all', 'round-robin']),
  env: z.record(z.string()).default({}),
  extraArgs: z.array(z.string()).default([]),
});
export type ViewerSpec = z.infer<typeof ViewerSpec>;

export const AdmissionConfig = z.object({
  bootstrapVcpu: z.number().positive(),
  steadyVcpu: z.number().positive(),
  targetUtilisation: z.number().positive(),
  minStartIntervalMs: z.number().nonnegative(),
  startJitterMs: z.number().nonnegative(),
  /** How long a viewer counts as bootstrapping if it never reports `joined`. */
  bootstrapTimeoutMs: z.number().positive(),
  /** `flood` disables both bounds on purpose, and marks the run incomparable. */
  disabled: z.boolean().default(false),
});
export type AdmissionConfig = z.infer<typeof AdmissionConfig>;

// ---------------------------------------------------------------- controller →

export const Configure = z.object({
  kind: z.literal('configure'),
  runId: z.string(),
  agentName: z.string(),
  agentIndex: z.number().int().nonnegative(),
  outDir: z.string(),
  spec: ViewerSpec,
  admission: AdmissionConfig,
  sampleIntervalMs: z.number().positive(),
  countSockets: z.boolean().default(false),
  maxViewers: z.number().int().nonnegative(),
});

/**
 * Two numbers, because "how many at once" and "how many altogether" are
 * different questions and conflating them relaunches a finished cohort forever.
 *
 * `concurrent` is how many viewers the agent should be holding; `totalStarts`
 * is how many it may ever start. A cohort sets them equal, so viewers that
 * finish are not replaced. A ramp sets `totalStarts` a little higher, so a
 * crashed viewer is replaced without a crash-looping binary being able to fork
 * the machine to death.
 */
export const SetTarget = z.object({
  kind: z.literal('set_target'),
  concurrent: z.number().int().nonnegative(),
  totalStarts: z.number().int().nonnegative(),
});
export const Stop = z.object({ kind: z.literal('stop'), graceMs: z.number().nonnegative() });
export const Collect = z.object({ kind: z.literal('collect') });
export const Shutdown = z.object({ kind: z.literal('shutdown') });
export const Ping = z.object({ kind: z.literal('ping'), id: z.number().int(), controllerClockMs: z.number() });

export const ToAgent = z.discriminatedUnion('kind', [
  Configure,
  SetTarget,
  Stop,
  Collect,
  Shutdown,
  Ping,
]);
export type ToAgent = z.infer<typeof ToAgent>;

// ---------------------------------------------------------------- agent →

export const Hello = z.object({
  kind: z.literal('hello'),
  agent: z.string(),
  machine: MachineInfo,
  agentClockMs: z.number(),
  version: z.string(),
});

export const Ready = z.object({
  kind: z.literal('ready'),
  agent: z.string(),
  preflight: PreflightReport,
});

export const ViewerStarted = z.object({
  kind: z.literal('viewer_started'),
  agent: z.string(),
  viewerId: z.string(),
  pid: z.number().int(),
  owner: z.string(),
  topic: z.string(),
  peerLimit: z.number().int(),
  live: z.boolean(),
  agentClockMs: z.number(),
});

export const ViewerLine = z.object({
  kind: z.literal('viewer_line'),
  agent: z.string(),
  viewerId: z.string(),
  line: z.string(),
});

export const ViewerExited = z.object({
  kind: z.literal('viewer_exited'),
  agent: z.string(),
  viewerId: z.string(),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  requested: z.boolean(),
  agentClockMs: z.number(),
});

export const Samples = z.object({
  kind: z.literal('samples'),
  agent: z.string(),
  machine: MachineSample,
  viewers: z.array(ViewerSample),
});

export const AgentState = z.object({
  kind: z.literal('state'),
  agent: z.string(),
  target: z.number().int(),
  totalStarts: z.number().int(),
  startsExhausted: z.boolean().default(false),
  active: z.number().int(),
  bootstrapping: z.number().int(),
  started: z.number().int(),
  exited: z.number().int(),
  admissionReason: z.string().optional(),
});

export const AgentLog = z.object({
  kind: z.literal('log'),
  agent: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
});

export const FileBegin = z.object({ kind: z.literal('file_begin'), agent: z.string(), path: z.string() });
export const FileChunk = z.object({ kind: z.literal('file_chunk'), agent: z.string(), path: z.string(), base64: z.string() });
export const FileEnd = z.object({ kind: z.literal('file_end'), agent: z.string(), path: z.string() });
export const Collected = z.object({ kind: z.literal('collected'), agent: z.string(), files: z.number().int() });
export const Pong = z.object({ kind: z.literal('pong'), agent: z.string(), id: z.number().int(), agentClockMs: z.number() });

export const FromAgent = z.discriminatedUnion('kind', [
  Hello,
  Ready,
  ViewerStarted,
  ViewerLine,
  ViewerExited,
  Samples,
  AgentState,
  AgentLog,
  FileBegin,
  FileChunk,
  FileEnd,
  Collected,
  Pong,
]);
export type FromAgent = z.infer<typeof FromAgent>;
