/**
 * The controller owns a run: connect agents, ramp toward a target, watch the
 * KPIs, stop, collect, report.
 *
 * It never decides when an individual viewer starts — that is the agent's call,
 * because only the agent can see its machine's CPU. The controller decides how
 * many viewers a machine should be holding, and the agent gets there as fast as
 * its own budget allows.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { cohortKpis, type CohortKpis, ThroughputWindow } from './metrics/aggregate.js';
import {
  controllerClockSuspect,
  evaluateGuards,
  type GuardVerdict,
  guardsValid,
} from './metrics/guard.js';
import { partition } from './schedule.js';
import type { ResolvedScenario } from './scenario.js';
import { localChannelPair } from './transport/local.js';
import type { Channel } from './transport/channel.js';
import {
  type FromAgent,
  type MachineInfo,
  type MachineSample,
  type PreflightReport,
  type ToAgent,
} from './transport/protocol.js';
import { sshChannel } from './transport/ssh.js';
import { FleetAgent } from './agent/agent.js';
import { parseViewerEvent } from './viewer/contract.js';
import { MOCK_BINARY } from './viewer/spawn.js';
import { type ViewerRecord, ViewerRollup } from './viewer/rollup.js';
import { writeJson } from './run-dir.js';

const HELLO_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 60_000;
const COLLECT_TIMEOUT_MS = 120_000;
const SSH_STDERR_TAIL = 6;
const CLOCK_PINGS = 9;
const CLOCK_PING_SPACING_MS = 40;

export interface AgentReport {
  name: string;
  host: string;
  weight: number;
  maxViewers: number;
  machine?: MachineInfo | undefined;
  preflight?: PreflightReport | undefined;
  clockOffsetMs?: number | undefined;
  /** Smallest round trip seen while measuring the offset: its error bound. */
  clockRttMs?: number | undefined;
  samples: MachineSample[];
  startTimestamps: number[];
  guards: GuardVerdict[];
  viewersStarted: number;
}

export interface RampStep {
  atMs: number;
  elapsedS: number;
  target: number;
  active: number;
  degradedFraction?: number | undefined;
  realtimeFactorP95?: number | undefined;
  joinSuccessRate?: number | undefined;
  aggregateMbps?: number | undefined;
}

export interface LiveSnapshot {
  elapsedS: number;
  target: number;
  active: number;
  bootstrapping: number;
  started: number;
  exited: number;
  joined: number;
  degradedFraction?: number | undefined;
  stallRatioP95?: number | undefined;
  realtimeFactorP95?: number | undefined;
  windowMbps: number;
  segments: number;
  bytes: number;
  guardsOk: boolean;
  agents: AgentSnapshot[];
}

/**
 * One machine, as the live view sees it.
 *
 * Everything below `active` comes from the agent's most recent resource sample,
 * so it is absent for the first second of a run and absent for good if the
 * platform would not give the agent a counter. A missing number renders as `-`
 * rather than as a zero: "we did not measure that" and "that was zero" are
 * different facts about a machine.
 */
export interface AgentSnapshot {
  name: string;
  host: string;
  target: number;
  active: number;
  bootstrapping: number;
  cores?: number | undefined;
  cpuUtilisation?: number | undefined;
  loadAvg1?: number | undefined;
  memUsedFraction?: number | undefined;
  viewerRssBytes?: number | undefined;
  rxMbps?: number | undefined;
  txMbps?: number | undefined;
  establishedSockets?: number | undefined;
  admissionReason?: string | undefined;
  /** Name of the first breached guard on this machine, if any. */
  breachedGuard?: string | undefined;
}

export interface RunResult {
  runId: string;
  runDir: string;
  label: string;
  mode: string;
  startedAtMs: number;
  endedAtMs: number;
  durationS: number;
  stoppedBecause: string;
  valid: boolean;
  comparable: boolean;
  invalidBecause: string[];
  caveats: string[];
  kpis: CohortKpis;
  records: ViewerRecord[];
  agents: AgentReport[];
  rampSteps: RampStep[];
  scenario: unknown;
}

interface AgentLink {
  report: AgentReport;
  channel: Channel<ToAgent, FromAgent>;
  kill: (() => void) | undefined;
  target: number;
  totalStarts: number;
  startsExhausted: boolean;
  active: number;
  bootstrapping: number;
  started: number;
  exited: number;
  admissionReason?: string | undefined;
  dialFailureSeries: number[];
  /** Viewers still bootstrapping at each sample, parallel to the series above. */
  bootstrappingSeries: number[];
  lastSample?: MachineSample | undefined;
  ready: boolean;
  helloSeen: boolean;
  collectDone: boolean;
  /** Last few lines ssh wrote to stderr, kept to explain a silent agent. */
  sshStderr: string[];
  incoming: Map<string, WriteStream>;
  /** Append-only resource series for this machine, opened on its first sample. */
  sampleLog?: WriteStream | undefined;
}

export interface ControllerHooks {
  onSnapshot?: (snapshot: LiveSnapshot) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class Controller {
  private readonly links: AgentLink[] = [];
  private readonly rollups = new Map<string, ViewerRollup>();
  private readonly throughput = new ThroughputWindow(10_000);
  private readonly rampSteps: RampStep[] = [];
  private readonly invalidBecause: string[] = [];
  private startedAtMs = 0;
  private requested = 0;
  private stoppedBecause = 'not started';
  private breachSinceMs: number | undefined;
  private ticker: NodeJS.Timeout | undefined;

  constructor(
    private readonly scenario: ResolvedScenario,
    private readonly runId: string,
    private readonly runDir: string,
    private readonly hooks: ControllerHooks = {},
  ) {}

  async run(force: boolean): Promise<RunResult> {
    this.startedAtMs = Date.now();
    await this.connect();
    await this.measureClocks();
    await this.configure();
    await this.awaitReady(force);

    await mkdir(path.join(this.runDir, 'machines'), { recursive: true });
    await writeJson(path.join(this.runDir, 'run.json'), this.runManifest());

    this.startTicking();
    try {
      if (this.scenario.ramp === undefined) {
        await this.driveFixed();
      } else {
        await this.driveRamp();
      }
    } finally {
      this.stopTicking();
    }

    await this.stopAll();
    await this.collectAll();
    this.closeSampleLogs();
    return this.finish();
  }

  // -------------------------------------------------------------- connect

  private async connect(): Promise<void> {
    const shares = partition(
      this.scenario.peakViewers,
      this.scenario.agents.map((agent) => agent.weight),
    );

    this.scenario.agents.forEach((target, index) => {
      const name = target.name ?? (target.host === 'local' ? 'local' : target.host);
      const cap = Math.min(target.maxViewers ?? Number.MAX_SAFE_INTEGER, shares[index] as number);
      const report: AgentReport = {
        name,
        host: target.host,
        weight: target.weight,
        maxViewers: cap,
        samples: [],
        startTimestamps: [],
        guards: [],
        viewersStarted: 0,
      };

      let channel: Channel<ToAgent, FromAgent>;
      let kill: (() => void) | undefined;
      const sshStderr: string[] = [];
      if (target.host === 'local') {
        const pair = localChannelPair();
        channel = pair.controllerSide;
        const agent = new FleetAgent(pair.agentSide);
        void agent.start();
      } else {
        const connection = sshChannel(
          target,
          (line) => {
            sshStderr.push(line);
            if (sshStderr.length > SSH_STDERR_TAIL) {
              sshStderr.shift();
            }
            this.hooks.onLog?.('warn', `${name}: ssh: ${line}`);
          },
          (_line, reason) => this.hooks.onLog?.('warn', `${name}: bad control line (${reason})`),
        );
        channel = connection.channel;
        kill = connection.kill;
      }

      const link: AgentLink = {
        report,
        channel,
        kill,
        target: 0,
        totalStarts: 0,
        startsExhausted: false,
        active: 0,
        bootstrapping: 0,
        started: 0,
        exited: 0,
        dialFailureSeries: [],
        bootstrappingSeries: [],
        ready: false,
        helloSeen: false,
        collectDone: false,
        sshStderr,
        incoming: new Map(),
      };
      this.links.push(link);
      channel.onMessage((message) => this.onAgentMessage(link, message));
      channel.onClose((reason) => {
        if (!link.collectDone) {
          this.invalid(`agent ${name} disconnected (${reason ?? 'unknown'})`);
        }
      });
    });

    try {
      await this.waitFor(
        () => this.links.every((link) => link.helloSeen),
        HELLO_TIMEOUT_MS,
        'agents did not say hello',
      );
    } catch {
      throw new Error(this.silentAgentReport());
    }
  }

  /**
   * Why an agent never spoke.
   *
   * The cause is almost always on the far side of the pipe and is almost always
   * already written to ssh's stderr — a missing command, a refused key, an
   * unknown host. Left to the timeout alone, all of that shows as `agents did
   * not say hello` 30 seconds later, so the first remote run without `--deploy`
   * cost half a minute and a scroll back through the log to find
   * `swarm-fleet: command not found`.
   */
  private silentAgentReport(): string {
    const lines = ['agents did not say hello:'];
    for (const link of this.links.filter((candidate) => !candidate.helloSeen)) {
      const tail = link.sshStderr.length > 0 ? link.sshStderr.join('; ') : 'no output from ssh';
      lines.push(`  ${link.report.name}: ${tail}`);
      if (link.sshStderr.some((line) => /command not found|No such file/i.test(line))) {
        lines.push(
          '    The agent is not installed on that host. Pass --deploy (optionally with ' +
            '--from-github) to push it there, or give the agent an explicit `command` in a ' +
            'scenario file if the fleet is installed somewhere unusual.',
        );
      }
      if (link.sshStderr.some((line) => /Permission denied|publickey|Host key/i.test(line))) {
        lines.push(
          '    ssh could not log in. The controller needs key access to this host: agents ' +
            'run over BatchMode ssh, so there is no password prompt to answer.',
        );
      }
    }
    return lines.join('\n');
  }

  /**
   * Round-trip the control channel so cross-machine timelines line up.
   *
   * The offset is taken from the probe with the **smallest round trip**, not
   * from the median of all of them. Cristian's algorithm, and the reason is
   * measured rather than theoretical: against a real box over a WAN, the median
   * put the offset at 73 ms for a machine whose clock was 1.9 us off NTP. The
   * error is queuing delay, and the least-queued probe carries least of it —
   * a median instead averages the noise in.
   *
   * That mattered twice over: the controller subtracts this offset from every
   * viewer timestamp, and the clock-skew guard then invalidated the run for it.
   *
   * Probes are spaced, too, because the agent's Node process has just started
   * and a burst of back-to-back pings would all land in the same warm-up.
   */
  private async measureClocks(): Promise<void> {
    for (const link of this.links) {
      let best: { rttMs: number; offsetMs: number } | undefined;
      for (let probe = 0; probe < CLOCK_PINGS; probe += 1) {
        const sentAt = Date.now();
        const id = probe;
        const pong = new Promise<number>((resolve) => {
          this.pendingPongs.set(`${link.report.name}:${id}`, resolve);
        });
        link.channel.send({ kind: 'ping', id, controllerClockMs: sentAt });
        const agentClock = await Promise.race([
          pong,
          new Promise<number>((resolve) => setTimeout(() => resolve(Number.NaN), 5_000)),
        ]);
        const receivedAt = Date.now();
        if (Number.isFinite(agentClock)) {
          const rttMs = receivedAt - sentAt;
          const offsetMs = agentClock - (sentAt + receivedAt) / 2;
          if (best === undefined || rttMs < best.rttMs) {
            best = { rttMs, offsetMs };
          }
        }
        await sleep(CLOCK_PING_SPACING_MS);
      }
      if (best !== undefined) {
        link.report.clockOffsetMs = best.offsetMs;
        link.report.clockRttMs = best.rttMs;
      }
    }
  }

  private readonly pendingPongs = new Map<string, (agentClockMs: number) => void>();

  private async configure(): Promise<void> {
    for (const [index, link] of this.links.entries()) {
      link.channel.send({
        kind: 'configure',
        runId: this.runId,
        agentName: link.report.name,
        agentIndex: index,
        outDir: link.report.host === 'local' ? this.runDir : path.join('/tmp', `swarm-fleet-${this.runId}`),
        spec: this.scenario.spec,
        admission: this.scenario.admission,
        sampleIntervalMs: this.scenario.sampleIntervalMs,
        countSockets: this.scenario.countSockets,
        maxViewers: link.report.maxViewers,
      });
    }
  }

  private async awaitReady(force: boolean): Promise<void> {
    await this.waitFor(
      () => this.links.every((link) => link.ready),
      READY_TIMEOUT_MS,
      'agents did not finish preflight',
    );

    const failures: string[] = [];
    for (const link of this.links) {
      for (const check of link.report.preflight?.checks ?? []) {
        if (!check.ok && check.fatal) {
          failures.push(`${link.report.name}: ${check.name}: ${check.detail}`);
        }
      }
    }
    // Every agent must be running the same build, or the run is measuring two
    // different viewers and reporting one number.
    const binaries = new Set(
      this.links
        .map((link) => link.report.preflight?.binarySha256)
        .filter((sha): sha is string => sha !== undefined),
    );
    if (binaries.size > 1) {
      failures.push(`agents are running ${binaries.size} different viewer builds`);
    }

    if (failures.length > 0) {
      if (!force) {
        throw new Error(`preflight refused the run:\n  ${failures.join('\n  ')}`);
      }
      for (const failure of failures) {
        this.invalid(`preflight overridden with --force: ${failure}`);
      }
    }
  }

  // ---------------------------------------------------------------- drive

  /**
   * How many viewers each agent should hold, and how many it may ever start.
   *
   * `replacements` is the difference. A cohort wants none: its viewers are
   * bounded by `--segments` or `--duration`, they finish, and replacing them
   * would turn a 6-viewer run into an endless one. A ramp wants a few, so that
   * a viewer lost to a crash does not silently lower the concurrency the run
   * believes it is testing — but bounded, because an unbounded replacement
   * policy against a binary that crashes on startup forks the machine to death.
   */
  private setTotalTarget(total: number, replacements: 'none' | 'bounded'): void {
    this.requested = Math.max(this.requested, total);
    const shares = partition(total, this.links.map((link) => link.report.weight));
    this.links.forEach((link, index) => {
      const share = Math.min(shares[index] as number, link.report.maxViewers);
      const totalStarts =
        replacements === 'none' ? share : share + Math.ceil(share * 0.25) + 5;
      link.target = share;
      link.totalStarts = Math.max(link.totalStarts, totalStarts);
      link.channel.send({
        kind: 'set_target',
        concurrent: share,
        totalStarts: link.totalStarts,
      });
    });
  }

  private async driveFixed(): Promise<void> {
    const total = this.scenario.raw.viewers ?? this.scenario.peakViewers;
    // Viewers here are bounded by segments or a duration, so they finish on
    // their own and must not be replaced when they do.
    this.setTotalTarget(total, 'none');

    const deadline = this.startedAtMs + this.scenario.maxRunS * 1_000;
    // Viewers bounded by `--segments` or `--duration` end on their own; the
    // run is over when every requested viewer has started and none is left.
    const spent = (): boolean =>
      this.links.every((link) => link.startsExhausted || link.target === 0);
    await this.waitFor(
      () => spent() && this.totalActive() === 0,
      Math.max(deadline - Date.now(), 1_000),
      undefined,
    );
    this.stoppedBecause =
      spent() && this.totalActive() === 0
        ? `every one of ${this.totalStarted()} viewers finished`
        : `hit the ${this.scenario.maxRunS}s run ceiling`;
  }

  private async driveRamp(): Promise<void> {
    const ramp = this.scenario.ramp as NonNullable<ResolvedScenario['ramp']>;
    const deadlineMs = this.startedAtMs + this.scenario.maxRunS * 1_000;

    for (let target = ramp.start; target <= ramp.max; target += ramp.step) {
      this.setTotalTarget(target, 'bounded');
      const stepEndsAt = Date.now() + ramp.intervalS * 1_000;

      const outcome = await this.waitForOutcome(Math.min(stepEndsAt, deadlineMs));
      this.recordRampStep(target);
      if (outcome !== undefined) {
        this.stoppedBecause = outcome;
        return;
      }
      if (Date.now() >= deadlineMs) {
        this.stoppedBecause = `hit the ${this.scenario.maxRunS}s run ceiling`;
        return;
      }
    }
    this.stoppedBecause = `reached the ramp ceiling of ${ramp.max} viewers without a breach`;
  }

  /**
   * Wait out a ramp step, returning early if the run should stop.
   *
   * A KPI breach must hold for `stop.holdS` before it counts: one slow segment
   * across 200 viewers is weather, not a cliff. A *guard* breach returns
   * immediately and invalidates — if the rig ran out of CPU there is no
   * capacity figure to record, only a mistake to report.
   */
  private async waitForOutcome(untilMs: number): Promise<string | undefined> {
    while (Date.now() < untilMs) {
      await sleep(500);

      const guards = this.evaluateAllGuards();
      if (!guardsValid(guards)) {
        const breached = guards.filter((guard) => guard.status === 'breached');
        for (const guard of breached) {
          this.invalid(`guard ${guard.name}: ${guard.detail}`);
        }
        return `guard breach: ${breached.map((guard) => guard.name).join(', ')}`;
      }

      const kpis = this.liveKpis();
      const degraded = kpis.degradedFraction;
      const joinRate = kpis.joinSuccessRate;
      const breaching =
        (degraded !== undefined && degraded > this.scenario.stop.degradedFraction) ||
        (joinRate !== undefined && joinRate < this.scenario.stop.joinSuccessRate);

      if (!breaching) {
        this.breachSinceMs = undefined;
        continue;
      }
      this.breachSinceMs = this.breachSinceMs ?? Date.now();
      if (Date.now() - this.breachSinceMs >= this.scenario.stop.holdS * 1_000) {
        const parts: string[] = [];
        if (degraded !== undefined && degraded > this.scenario.stop.degradedFraction) {
          parts.push(
            `${(degraded * 100).toFixed(1)}% of viewers degraded (limit ${(this.scenario.stop.degradedFraction * 100).toFixed(0)}%)`,
          );
        }
        if (joinRate !== undefined && joinRate < this.scenario.stop.joinSuccessRate) {
          parts.push(`join success ${(joinRate * 100).toFixed(1)}%`);
        }
        return `stop condition held for ${this.scenario.stop.holdS}s: ${parts.join('; ')}`;
      }
    }
    return undefined;
  }

  private recordRampStep(target: number): void {
    const kpis = this.liveKpis();
    this.rampSteps.push({
      atMs: Date.now(),
      elapsedS: (Date.now() - this.startedAtMs) / 1000,
      target,
      active: this.totalActive(),
      degradedFraction: kpis.degradedFraction,
      realtimeFactorP95: kpis.realtimeFactorP95,
      joinSuccessRate: kpis.joinSuccessRate,
      aggregateMbps: this.throughput.mbps(Date.now()),
    });
  }

  // ----------------------------------------------------------- shutdown

  private async stopAll(): Promise<void> {
    for (const link of this.links) {
      link.target = 0;
      link.channel.send({ kind: 'stop', graceMs: this.scenario.graceMs });
    }
    // Give viewers the grace period plus a little, so a viewer that handles
    // SIGTERM can finish and emit its authoritative summary.
    await this.waitFor(
      () => this.totalActive() === 0,
      this.scenario.graceMs + 10_000,
      undefined,
    );
  }

  private async collectAll(): Promise<void> {
    const remote = this.links.filter((link) => link.report.host !== 'local');
    if (remote.length === 0) {
      for (const link of this.links) {
        link.collectDone = true;
      }
      return;
    }
    await mkdir(path.join(this.runDir, 'viewers'), { recursive: true });
    for (const link of remote) {
      link.channel.send({ kind: 'collect' });
    }
    await this.waitFor(
      () => remote.every((link) => link.collectDone),
      COLLECT_TIMEOUT_MS,
      undefined,
    );
    for (const link of this.links) {
      link.collectDone = true;
      link.channel.send({ kind: 'shutdown' });
      link.kill?.();
    }
  }

  private closeSampleLogs(): void {
    for (const link of this.links) {
      link.sampleLog?.end();
      link.sampleLog = undefined;
    }
  }

  // ------------------------------------------------------------ messages

  private onAgentMessage(link: AgentLink, message: FromAgent): void {
    switch (message.kind) {
      case 'hello':
        link.helloSeen = true;
        link.report.machine = message.machine;
        break;
      case 'ready':
        link.ready = true;
        link.report.preflight = message.preflight;
        break;
      case 'pong': {
        const key = `${link.report.name}:${message.id}`;
        this.pendingPongs.get(key)?.(message.agentClockMs);
        this.pendingPongs.delete(key);
        break;
      }
      case 'viewer_started': {
        const offset = link.report.clockOffsetMs ?? 0;
        this.rollups.set(
          message.viewerId,
          new ViewerRollup({
            viewerId: message.viewerId,
            agent: link.report.name,
            owner: message.owner,
            topic: message.topic,
            peerLimit: message.peerLimit,
            live: message.live,
            startedAtMs: message.agentClockMs - offset,
          }),
        );
        link.started += 1;
        link.report.viewersStarted += 1;
        link.report.startTimestamps.push(message.agentClockMs);
        break;
      }
      case 'viewer_line': {
        const rollup = this.rollups.get(message.viewerId);
        if (rollup === undefined) {
          break;
        }
        const parsed = parseViewerEvent(message.line);
        if (!parsed.ok) {
          rollup.noteMalformed();
          break;
        }
        if (!parsed.known) {
          rollup.noteUnknown();
        }
        if (parsed.event.ev === 'segment') {
          this.throughput.record(Date.now(), parsed.event.bytes as number);
        }
        rollup.apply(parsed.event);
        break;
      }
      case 'viewer_exited': {
        const offset = link.report.clockOffsetMs ?? 0;
        this.rollups
          .get(message.viewerId)
          ?.noteExit(
            { code: message.code, signal: message.signal, requested: message.requested },
            message.agentClockMs - offset,
          );
        link.exited += 1;
        break;
      }
      case 'state':
        link.active = message.active;
        link.bootstrapping = message.bootstrapping;
        link.startsExhausted = message.startsExhausted;
        link.admissionReason = message.admissionReason;
        break;
      case 'samples': {
        link.report.samples.push(message.machine);
        link.lastSample = message.machine;
        this.recordSample(link, message.machine);
        for (const sample of message.viewers) {
          this.rollups.get(sample.viewerId)?.noteResource(sample.rssBytes, sample.cpuSeconds);
        }
        link.dialFailureSeries.push(this.dialFailuresFor(link.report.name));
        link.bootstrappingSeries.push(link.bootstrapping);
        break;
      }
      case 'log':
        this.hooks.onLog?.(message.level, `${message.agent}: ${message.message}`);
        break;
      case 'file_begin': {
        const destination = path.join(this.runDir, message.path);
        link.incoming.set(message.path, createWriteStream(destination, { flags: 'w' }));
        break;
      }
      case 'file_chunk':
        link.incoming.get(message.path)?.write(Buffer.from(message.base64, 'base64'));
        break;
      case 'file_end':
        link.incoming.get(message.path)?.end();
        link.incoming.delete(message.path);
        break;
      case 'collected':
        link.collectDone = true;
        break;
    }
  }

  /**
   * The resource series, on disk, one JSON object per sample.
   *
   * `summary.json` keeps only peaks, which is the right shape for comparing
   * runs and the wrong shape for explaining one: a 56% CPU spike lasting a
   * second is invisible next to a 1-minute load average of 0.82, and answering
   * "was that real?" after the fact needs the series, not its maximum. Written
   * as it arrives rather than at the end, so a run that dies still leaves it.
   */
  private recordSample(link: AgentLink, sample: MachineSample): void {
    if (link.sampleLog === undefined) {
      const name = link.report.name.replace(/[^A-Za-z0-9._-]/g, '-');
      link.sampleLog = createWriteStream(path.join(this.runDir, 'machines', `${name}.ndjson`), {
        flags: 'a',
      });
    }
    link.sampleLog.write(
      `${JSON.stringify({
        agent: link.report.name,
        elapsedS: Number(((sample.atMs - this.startedAtMs) / 1000).toFixed(3)),
        active: link.active,
        bootstrapping: link.bootstrapping,
        ...sample,
      })}\n`,
    );
  }

  // --------------------------------------------------------------- state

  private agents(): AgentReport[] {
    return this.links.map((link) => link.report);
  }

  private totalActive(): number {
    return this.links.reduce((total, link) => total + link.active, 0);
  }

  private totalStarted(): number {
    return this.links.reduce((total, link) => total + link.started, 0);
  }

  private records(): ViewerRecord[] {
    return [...this.rollups.values()].map((rollup) => rollup.finish());
  }

  private liveKpis(): CohortKpis {
    const elapsed = (Date.now() - this.startedAtMs) / 1000;
    return cohortKpis(this.records(), this.requested, elapsed);
  }

  private dialFailuresFor(agent: string): number {
    let total = 0;
    for (const record of this.records()) {
      if (record.agent === agent) {
        total += record.dialFailures;
      }
    }
    return total;
  }

  private evaluateAllGuards(): GuardVerdict[] {
    const verdicts: GuardVerdict[] = [];
    for (const link of this.links) {
      const machine = link.report.machine;
      if (machine === undefined) {
        continue;
      }
      const guards = evaluateGuards({
        machine,
        samples: link.report.samples,
        startTimestamps: link.report.startTimestamps,
        minStartIntervalMs: this.scenario.admission.minStartIntervalMs,
        admissionDisabled: this.scenario.admission.disabled,
        clockOffsetMs: link.report.clockOffsetMs,
        clockRttMs: link.report.clockRttMs,
        dialFailureSeries: link.dialFailureSeries,
        bootstrappingSeries: link.bootstrappingSeries,
      });
      link.report.guards = guards;
      verdicts.push(...guards.map((guard) => ({ ...guard, name: `${link.report.name}/${guard.name}` })));
    }
    return verdicts;
  }

  /**
   * One machine's live line. Reads the newest sample rather than an average:
   * the question a live view answers is "what is happening now".
   */
  private agentSnapshot(link: AgentLink): AgentSnapshot {
    const sample = link.lastSample;
    const machine = link.report.machine;
    const breached = link.report.guards.find((guard) => guard.status === 'breached');
    const used =
      sample === undefined ? undefined : sample.viewerRssTotalBytes + sample.agentRssBytes;
    return {
      name: link.report.name,
      host: link.report.host,
      target: link.target,
      active: link.active,
      bootstrapping: link.bootstrapping,
      cores: machine?.cores,
      cpuUtilisation: sample?.cpuUtilisation,
      loadAvg1: sample?.loadAvg1,
      memUsedFraction:
        used === undefined || machine === undefined ? undefined : used / machine.totalMemBytes,
      viewerRssBytes: sample?.viewerRssTotalBytes,
      rxMbps: sample?.rxBytesPerSec === undefined ? undefined : (sample.rxBytesPerSec * 8) / 1e6,
      txMbps: sample?.txBytesPerSec === undefined ? undefined : (sample.txBytesPerSec * 8) / 1e6,
      establishedSockets: sample?.establishedSockets,
      admissionReason: link.admissionReason,
      breachedGuard: breached?.name,
    };
  }

  private startTicking(): void {
    this.ticker = setInterval(() => {
      const kpis = this.liveKpis();
      // Guards first: `agentSnapshot` reads the verdicts this refreshes.
      const guardsOk = guardsValid(this.evaluateAllGuards());
      this.hooks.onSnapshot?.({
        elapsedS: (Date.now() - this.startedAtMs) / 1000,
        target: this.links.reduce((total, link) => total + link.target, 0),
        active: this.totalActive(),
        bootstrapping: this.links.reduce((total, link) => total + link.bootstrapping, 0),
        started: this.totalStarted(),
        exited: this.links.reduce((total, link) => total + link.exited, 0),
        joined: kpis.viewers.joined,
        degradedFraction: kpis.degradedFraction,
        stallRatioP95: kpis.stallRatio.p95,
        realtimeFactorP95: kpis.realtimeFactorP95,
        windowMbps: this.throughput.mbps(Date.now()),
        segments: kpis.segments,
        bytes: kpis.bytes,
        guardsOk,
        agents: this.links.map((link) => this.agentSnapshot(link)),
      });
    }, 1_000);
    this.ticker.unref();
  }

  private stopTicking(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private invalid(reason: string): void {
    if (!this.invalidBecause.includes(reason)) {
      this.invalidBecause.push(reason);
    }
  }

  // -------------------------------------------------------------- finish

  private runManifest(): unknown {
    return {
      runId: this.runId,
      label: this.scenario.label,
      mode: this.scenario.mode,
      startedAt: new Date(this.startedAtMs).toISOString(),
      comparable: this.scenario.comparable,
      incomparableBecause: this.scenario.incomparableBecause,
      scenario: this.scenario.raw,
      resolved: {
        peakViewers: this.scenario.peakViewers,
        spec: this.scenario.spec,
        admission: this.scenario.admission,
        stop: this.scenario.stop,
        maxRunS: this.scenario.maxRunS,
        countSockets: this.scenario.countSockets,
      },
      controller: {
        hostname: process.env['HOSTNAME'] ?? 'unknown',
        nodeVersion: process.version,
        hostsViewers: this.scenario.agents.some((agent) => agent.host === 'local'),
      },
      agents: this.links.map((link) => ({
        name: link.report.name,
        host: link.report.host,
        weight: link.report.weight,
        maxViewers: link.report.maxViewers,
        machine: link.report.machine,
        preflight: link.report.preflight,
        clockOffsetMs: link.report.clockOffsetMs,
        clockRttMs: link.report.clockRttMs,
      })),
    };
  }

  private finish(): RunResult {
    const endedAtMs = Date.now();
    const durationS = (endedAtMs - this.startedAtMs) / 1000;
    const records = this.records();
    const kpis = cohortKpis(records, this.requested, durationS);
    const guards = this.evaluateAllGuards();
    for (const guard of guards.filter((verdict) => verdict.status === 'breached')) {
      this.invalid(`guard ${guard.name}: ${guard.detail}`);
    }
    // Every agent is measured against this one controller, so agents that agree
    // on their offset are not the ones with the wrong clock.
    const offsets = this.agents()
      .map((agent) => agent.clockOffsetMs)
      .filter((offset): offset is number => offset !== undefined);
    if (controllerClockSuspect(offsets)) {
      this.invalid(
        `every agent reports the controller's clock as ${(-(offsets[0] as number)).toFixed(0)} ms ` +
          'out: fix NTP on the controller, not on the agents',
      );
    }
    // No resource samples in a run long enough to expect them means the guards
    // returned `no_data` rather than `ok`, and an unguarded run is not a
    // measurement. A run shorter than a few sample periods is exempt.
    const expectSamples = durationS > (this.scenario.sampleIntervalMs / 1000) * 3;
    for (const agent of this.agents()) {
      if (expectSamples && agent.samples.length === 0) {
        this.invalid(
          `agent ${agent.name} produced no resource samples in ${durationS.toFixed(0)}s, ` +
            'so nothing guarded this run',
        );
      }
    }
    // Viewers that died on their own were not measuring anything, and a run
    // that lost a meaningful share of them was measuring a smaller fleet than
    // it reports.
    const crashed = kpis.viewers.byOutcome.crashed + kpis.viewers.byOutcome.never_joined;
    if (crashed > 0 && crashed > kpis.viewers.started * 0.05) {
      this.invalid(
        `${crashed} of ${kpis.viewers.started} viewers crashed or never joined, so the ` +
          'fleet was smaller than the concurrency this run reports',
      );
    }

    return {
      runId: this.runId,
      runDir: this.runDir,
      label: this.scenario.label,
      mode: this.scenario.mode,
      startedAtMs: this.startedAtMs,
      endedAtMs,
      durationS,
      stoppedBecause: this.stoppedBecause,
      valid: this.invalidBecause.length === 0,
      comparable: this.scenario.comparable,
      invalidBecause: [...this.invalidBecause],
      caveats: this.caveats(records, kpis),
      kpis,
      records,
      agents: this.links.map((link) => link.report),
      rampSteps: this.rampSteps,
      scenario: this.scenario.raw,
    };
  }

  /**
   * Standing reasons a number here may not mean what it appears to.
   *
   * These are evidence-based, not boilerplate: each one is emitted only when
   * this run actually shows the condition.
   */
  private caveats(records: readonly ViewerRecord[], kpis: CohortKpis): string[] {
    // Scenario-level caveats first: they are true before the run starts.
    const caveats: string[] = [...this.scenario.caveats];
    if (this.scenario.spec.binary === MOCK_BINARY) {
      caveats.push(
        'ran against the built-in mock viewer: this measures the rig, not Swarm.',
      );
    }
    if (kpis.skippedTotal > 0 && kpis.reconstructProbes === 0) {
      caveats.push(
        `viewers skipped ${kpis.skippedTotal} segments to the live edge and no history ` +
          'reconstruction was observed, so the load is under-reported. Real viewers rebuild ' +
          'missing history (NEXT-STEP.md 1b) at exactly the moment the network is already ' +
          'struggling, which is a feedback loop this run does not reproduce.',
      );
    }
    if (!this.scenario.comparable && this.scenario.incomparableBecause !== undefined) {
      caveats.push(this.scenario.incomparableBecause);
    }
    const oneStream = (kpis.distinctContentRatio ?? 1) * records.length <= 1 && records.length > 1;
    if (oneStream) {
      caveats.push(
        'every viewer watched the same stream, so forwarding-node caching served much of ' +
          'this load. Treat the result as a popularity test, not as capacity for a diverse ' +
          'audience; use several streams to separate the two.',
      );
    }
    if (kpis.malformedLines > 0) {
      caveats.push(`${kpis.malformedLines} viewer output lines could not be parsed.`);
    }
    return caveats;
  }

  private async waitFor(
    done: () => boolean,
    timeoutMs: number,
    timeoutMessage: string | undefined,
  ): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() >= until) {
        if (timeoutMessage !== undefined) {
          throw new Error(timeoutMessage);
        }
        return;
      }
      await sleep(100);
    }
  }

  /** Emergency path: used by the CLI's signal handler. */
  async abort(reason: string): Promise<void> {
    this.invalid(`aborted: ${reason}`);
    this.stoppedBecause = `aborted: ${reason}`;
    this.stopTicking();
    await this.stopAll();
    for (const link of this.links) {
      link.channel.send({ kind: 'shutdown' });
      link.kill?.();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
