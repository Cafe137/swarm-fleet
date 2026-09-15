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
import {
  describePeerShortfall,
  type PeerAttainment,
  summarisePeerAttainment,
} from './metrics/peers.js';
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
  /** Viewers preflight was sized against, when that is not `maxViewers`. */
  sizeViewers: number;
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
  /** Peers held across the fleet, and the share of what was asked for. */
  peersHeld?: number | undefined;
  peerAttainedFraction?: number | undefined;
}

export interface LiveSnapshot {
  elapsedS: number;
  target: number;
  active: number;
  bootstrapping: number;
  /** Viewers peered and parked at the barrier, during a settle phase. */
  held?: number | undefined;
  started: number;
  exited: number;
  joined: number;
  degradedFraction?: number | undefined;
  stallRatioP95?: number | undefined;
  realtimeFactorP95?: number | undefined;
  windowMbps: number;
  segments: number;
  bytes: number;
  /** Stall events so far, and peers held right now. Both for the human, live. */
  stalls: number;
  peersHeld: number;
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
  held?: number | undefined;
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
  /**
   * When the cohort was released and the measurement actually began.
   *
   * Equal to `startedAtMs` for a run with no settle phase. The KPI window is
   * measured from here, because dividing a run's bytes by a window that
   * includes its own ramp reports a throughput no viewer ever saw.
   */
  measuredFromMs: number;
  endedAtMs: number;
  durationS: number;
  /** Seconds spent peering and parked before the barrier opened. */
  settleS: number;
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
  held: number;
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
  /**
   * Called once the settled cohort is peered and parked, before the barrier
   * opens. This is where a run that publishes its own stream starts ffmpeg: the
   * viewers are all there, so nothing is published that nobody watches and no
   * viewer spends its join budget polling a feed that does not exist yet.
   */
  onSettled?: () => Promise<void>;
}

export class Controller {
  private readonly links: AgentLink[] = [];
  private readonly rollups = new Map<string, ViewerRollup>();
  private readonly throughput = new ThroughputWindow(10_000);
  private readonly rampSteps: RampStep[] = [];
  private readonly invalidBecause: string[] = [];
  private startedAtMs = 0;
  /** When the barrier opened. Equal to `startedAtMs` without a settle phase. */
  private measuredFromMs = 0;
  /** Caveats observed during the run, alongside the scenario's own. */
  private readonly observedCaveats: string[] = [];
  private aborted = false;
  /** Controller-clock instant the most recent viewer started. */
  private lastViewerStartMs = 0;
  /** Controller-clock instant the most recent viewer reported joining. */
  private lastViewerJoinMs = 0;
  /** Live per-viewer event logs, so a run that dies still leaves its data. */
  private readonly viewerLogs = new Map<string, WriteStream>();
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
    this.measuredFromMs = this.startedAtMs;
    await this.connect();
    await this.measureClocks();
    await this.configure();
    await this.awaitReady(force);

    await mkdir(path.join(this.runDir, 'machines'), { recursive: true });
    // Made up front, not at collect time: viewer events are streamed here from
    // the first one that arrives.
    await mkdir(path.join(this.runDir, 'viewers'), { recursive: true });
    await writeJson(path.join(this.runDir, 'run.json'), this.runManifest());

    this.startTicking();
    try {
      if (this.scenario.mode === 'session') {
        await this.driveSession();
      } else if (this.scenario.ramp === undefined) {
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
    const weights = this.scenario.agents.map((agent) => agent.weight);
    // Two partitions, because a session's ceiling and its opening cohort are
    // different numbers: the first caps what an agent will ever launch, the
    // second is what preflight judges the machine against.
    const shares = partition(this.scenario.viewerCeiling, weights);
    const startShares = partition(this.scenario.peakViewers, weights);

    this.scenario.agents.forEach((target, index) => {
      const name = target.name ?? (target.host === 'local' ? 'local' : target.host);
      const cap = Math.min(target.maxViewers ?? Number.MAX_SAFE_INTEGER, shares[index] as number);
      const report: AgentReport = {
        name,
        host: target.host,
        weight: target.weight,
        maxViewers: cap,
        sizeViewers: Math.min(cap, startShares[index] as number),
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
        held: 0,
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
        sizeViewers: link.report.sizeViewers,
        profile: this.scenario.profile,
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
   * `replacements` is the difference, and all three answers are a start budget
   * — one number the agent counts down — rather than three mechanisms:
   *
   * -   **`none`**, a cohort: its viewers are bounded by `--segments` or
   *     `--duration`, they finish, and replacing them would turn a 6-viewer run
   *     into an endless one.
   * -   **`bounded`**, a ramp: a few spare starts, so a viewer lost to a crash
   *     does not silently lower the concurrency the run believes it is testing,
   *     but not so many that a binary which crashes on startup forks the
   *     machine to death.
   * -   **`live`**, a session: the budget *slides*. It is set from what this
   *     agent has already started rather than accumulated with `Math.max`, so
   *     re-issuing the same target — which `driveSession` does every 30 s —
   *     genuinely tops it up. That is what makes a session able to replace
   *     viewers that retire after an hour, and to be scaled down and back up
   *     all evening, while still bounding a crash loop to `share + 5` starts
   *     per re-issue rather than thousands a second.
   */
  private setTotalTarget(total: number, replacements: 'none' | 'bounded' | 'live'): void {
    this.requested = Math.max(this.requested, total);
    const shares = partition(total, this.links.map((link) => link.report.weight));
    this.links.forEach((link, index) => {
      const share = Math.min(shares[index] as number, link.report.maxViewers);
      const totalStarts =
        replacements === 'none' ? share : share + Math.ceil(share * 0.25) + 5;
      link.target = share;
      link.totalStarts =
        replacements === 'live'
          ? link.started + share + 5
          : Math.max(link.totalStarts, totalStarts);
      link.channel.send({
        kind: 'set_target',
        concurrent: share,
        totalStarts: link.totalStarts,
        graceMs: this.scenario.graceMs,
      });
    });
  }

  // ---------------------------------------------------------------- session

  /**
   * The target a session is holding, and the only number the keyboard changes.
   *
   * Kept apart from `requested`, which is a high-water mark used for sizing:
   * a session that went to 60 and back to 20 asked for 60 once and is holding
   * 20 now, and both facts matter.
   */
  private sessionTarget = 0;

  /** The most viewers any one agent will accept, summed. */
  capacity(): number {
    return this.links.reduce((sum, link) => sum + link.report.maxViewers, 0);
  }

  /** What the session is holding right now. */
  target(): number {
    return this.sessionTarget;
  }

  /**
   * Ask for a different number of viewers, right now.
   *
   * Public, and the only public way to change a run's shape while it is
   * running. A session driver calls it from a keypress; nothing else does.
   * Clamped rather than validated: a participant leaning on the right arrow
   * should reach the machine's ceiling and stop there, not be told off.
   */
  setViewerTarget(total: number): number {
    const wanted = Math.max(0, Math.min(Math.round(total), this.capacity()));
    if (wanted === this.sessionTarget) {
      return wanted;
    }
    this.sessionTarget = wanted;
    this.setTotalTarget(wanted, 'live');
    this.recordRampStep(wanted);
    return wanted;
  }

  /**
   * Hold whatever target the keyboard last asked for, until someone stops it.
   *
   * There is no completion condition here on purpose. A cohort ends when its
   * viewers finish and a ramp ends when it breaches; a session ends when the
   * person running it says so, or when the run ceiling catches a terminal
   * somebody walked away from. Viewers that end on their own are replaced,
   * because a session is defined by how many viewers are up rather than by how
   * many were started.
   */
  private async driveSession(): Promise<void> {
    this.setViewerTarget(this.scenario.raw.viewers ?? this.scenario.peakViewers);

    const ceilingMs = this.startedAtMs + this.scenario.maxRunS * 1_000;
    const TOP_UP_MS = 30_000;
    let nextTopUpMs = Date.now() + TOP_UP_MS;
    // Polled rather than slept through: someone pressing `q` must be answered
    // now, not at the end of a housekeeping interval.
    while (!this.aborted && Date.now() < ceilingMs) {
      await sleep(200);
      if (this.aborted || Date.now() < nextTopUpMs) {
        continue;
      }
      nextTopUpMs = Date.now() + TOP_UP_MS;
      // Re-issuing the same target slides the start budget forward from what
      // has already been started (see `setTotalTarget`), which is what lets a
      // session replace the viewers it retires after an hour. Doing it on a
      // timer rather than continuously is also the crash-loop bound: a binary
      // that dies on startup costs `share + 5` starts every 30 s, not
      // thousands a second.
      this.setTotalTarget(this.sessionTarget, 'live');
    }

    this.stoppedBecause = this.aborted
      ? 'the session was stopped'
      : `hit the ${this.scenario.maxRunS}s run ceiling`;
  }

  private async driveFixed(): Promise<void> {
    const total = this.scenario.raw.viewers ?? this.scenario.peakViewers;
    // Viewers here are bounded by segments or a duration, so they finish on
    // their own and must not be replaced when they do.
    this.setTotalTarget(total, 'none');
    await this.settleAndRelease(total);

    const ceilingMs = this.measuredFromMs + this.scenario.maxRunS * 1_000;
    // Viewers bounded by `--segments` or `--duration` end on their own; the
    // run is over when every requested viewer has started and none is left.
    const spent = (): boolean =>
      this.links.every((link) => link.startsExhausted || link.target === 0);
    const finished = (): boolean => spent() && this.totalActive() === 0;

    await this.waitFor(
      () => this.aborted || finished() || this.stragglersOverdue(),
      Math.max(ceilingMs - Date.now(), 1_000),
      undefined,
    );

    if (this.aborted) {
      // `abort` has already stopped everything; saying so here stops the
      // straggler branch below from reporting a hang that did not happen.
      return;
    }
    if (finished()) {
      this.stoppedBecause = `every one of ${this.totalStarted()} viewers finished`;
      return;
    }

    // Past this point the run is over as far as the measurement goes, and what
    // is left is viewers that will not end themselves. Stopping them is the
    // whole point: waiting instead is what held the first Vultr run open for
    // fifteen minutes and cost it every viewer record it had collected.
    const hung = this.totalActive();
    if (this.stragglersOverdue()) {
      this.hooks.onLog?.('warn', `${hung} viewer(s) outlived their duration; stopping them`);
      await this.stopAll();
      const left = this.totalActive();
      this.stoppedBecause =
        `every one of ${this.totalStarted()} viewers finished, ` +
        `${hung} only after being stopped as hung` +
        (left === 0 ? '' : ` (${left} never acknowledged)`);
      // A hung viewer's own numbers are lost, so the run is not a clean
      // measurement of the fleet it claims to describe.
      this.invalid(`${hung} viewer(s) had to be killed after outliving their duration`);
      return;
    }
    this.stoppedBecause = `hit the ${this.scenario.maxRunS}s run ceiling`;
    await this.stopAll();
  }

  /**
   * Whether viewers are still alive well past the point they should have ended.
   *
   * Only meaningful for a duration-bounded run — `--segments` gives no instant
   * to measure from, so those keep the `maxRunS` ceiling as their only bound.
   *
   * The instant to measure from is the latest of three, because a viewer's
   * `--duration` clock does not start when the process does:
   *
   * -   its **start**, which is all there is for a cohort that was never held;
   * -   **release**, because `--hold` parks the viewer inside `peer_up` and the
   *     clock is taken after that returns (`main.rs::watch_live_stream`). A
   *     settled `--publish` run then spends the whole of `handle.joinable()`
   *     between the last start and release — ffmpeg coming up and writing 8 s
   *     of runway into Swarm — which is more than the straggler grace on its
   *     own;
   * -   the last **join**, because both run modes emit `joined` and only then
   *     take the playback clock, and a live join waits up to 30 s for a
   *     joinable window.
   *
   * Measuring from the start alone made the bound fire mid-measurement on
   * exactly the configuration it was written to protect, killing a healthy
   * cohort and reporting it as hung.
   */
  private stragglersOverdue(): boolean {
    const durationS = this.scenario.durationS;
    if (durationS === undefined || this.lastViewerStartMs === 0) {
      return false;
    }
    const from = Math.max(this.lastViewerStartMs, this.measuredFromMs, this.lastViewerJoinMs);
    const due = from + durationS * 1_000 + this.scenario.stragglerGraceS * 1_000;
    return Date.now() >= due && this.totalActive() > 0;
  }

  /**
   * Peer the whole cohort, start the stream, then start every viewer watching
   * at the same instant.
   *
   * The wait is on the viewers' own `held` events rather than on a delay: each
   * says when it has its peers and has parked, which is the only signal that
   * actually means "done dialing". A viewer that falls short of the target is
   * not fatal — the phase has a deadline, and a shortfall is recorded rather
   * than being allowed to hang a run that is otherwise fine.
   */
  private async settleAndRelease(total: number): Promise<void> {
    const settle = this.scenario.settle;
    if (settle === undefined) {
      return;
    }
    const capacity = this.links.reduce((sum, link) => sum + link.report.maxViewers, 0);
    const target = Math.min(total, capacity);
    this.hooks.onLog?.(
      'info',
      `settling: waiting for ${target} viewers to hold ${settle.peerUp} peers each`,
    );

    const ready = (): ViewerRecord[] =>
      this.records().filter(
        (record) => record.held && (record.peersLast ?? 0) >= settle.peerUp,
      );
    await this.waitFor(
      () => this.aborted || (this.totalStarted() >= target && ready().length >= target),
      settle.timeoutS * 1_000,
      undefined,
    );
    if (this.aborted) {
      return;
    }

    // What is actually being released, recorded before the publisher starts so
    // a shortfall survives even if the publisher then fails.
    const held = ready().length;
    const settleS = (Date.now() - this.startedAtMs) / 1000;
    if (held < target) {
      const lowest = this.records()
        .filter((record) => record.outcome === 'running')
        .map((record) => record.peersLast ?? 0)
        .sort((left, right) => left - right)[0];
      const detail =
        `${held} of ${target} viewers were holding ${settle.peerUp} peers after ` +
        `${settleS.toFixed(0)}s (${this.totalStarted()} started, lowest peer count ` +
        `${lowest ?? 0})`;
      this.caveat(
        `the cohort was released before it had settled: ${detail}. Joining and watching ` +
          'therefore overlapped for some viewers, which is the overlap settling exists to ' +
          'remove — raise settle.timeoutS, lower the viewer count, or add a machine.',
      );
      this.hooks.onLog?.('warn', `settle deadline reached: ${detail}`);
    } else {
      this.hooks.onLog?.(
        'info',
        `settled: ${target} viewers holding ${settle.peerUp} peers after ${settleS.toFixed(0)}s`,
      );
    }

    // The stream starts now, with the audience already in place.
    if (this.hooks.onSettled !== undefined) {
      this.hooks.onLog?.('info', 'starting the stream');
      await this.hooks.onSettled();
    }

    this.measuredFromMs = Date.now();
    for (const link of this.links) {
      link.channel.send({ kind: 'release' });
    }
    this.hooks.onLog?.('info', 'released; the measurement window starts here');
  }

  private async driveRamp(): Promise<void> {
    const ramp = this.scenario.ramp as NonNullable<ResolvedScenario['ramp']>;
    const deadlineMs = this.startedAtMs + this.scenario.maxRunS * 1_000;

    for (let target = ramp.start; target <= ramp.max; target += ramp.step) {
      this.setTotalTarget(target, 'bounded');
      const stepEndsAt = Date.now() + ramp.intervalS * 1_000;

      const outcome = await this.waitForOutcome(Math.min(stepEndsAt, deadlineMs));
      this.recordRampStep(target);
      if (this.aborted) {
        return;
      }
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
      // Checked first: a ramp step is up to `--ramp-interval` long, and an
      // operator who pressed Ctrl-C should not wait it out.
      if (this.aborted) {
        return 'aborted';
      }

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
      // The connection ceiling. Judged on peers *held*, so a fleet whose
      // viewers reached their target and then had connections taken back counts
      // as breaching — that shape is invisible to `degradedFraction`, which
      // only sees a viewer that is also stalling, and to `joinSuccessRate`,
      // which is about joining a stream rather than acquiring peers.
      const peers = summarisePeerAttainment(this.peerAttainmentFor());
      const attained = peers.judged === 0 ? undefined : peers.holding / peers.judged;
      const breaching =
        (degraded !== undefined && degraded > this.scenario.stop.degradedFraction) ||
        (joinRate !== undefined && joinRate < this.scenario.stop.joinSuccessRate) ||
        (attained !== undefined && attained < this.scenario.stop.peerAttainment);

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
        if (attained !== undefined && attained < this.scenario.stop.peerAttainment) {
          parts.push(describePeerShortfall(peers));
        }
        return `stop condition held for ${this.scenario.stop.holdS}s: ${parts.join('; ')}`;
      }
    }
    return undefined;
  }

  private recordRampStep(target: number): void {
    const kpis = this.liveKpis();
    const peers = summarisePeerAttainment(this.peerAttainmentFor());
    this.rampSteps.push({
      atMs: Date.now(),
      elapsedS: (Date.now() - this.startedAtMs) / 1000,
      target,
      active: this.totalActive(),
      degradedFraction: kpis.degradedFraction,
      realtimeFactorP95: kpis.realtimeFactorP95,
      joinSuccessRate: kpis.joinSuccessRate,
      aggregateMbps: this.throughput.mbps(Date.now()),
      peersHeld: peers.peersHeld,
      peerAttainedFraction: peers.attainedFraction,
    });
  }

  // ----------------------------------------------------------- shutdown

  private async stopAll(): Promise<void> {
    for (const link of this.links) {
      link.target = 0;
      link.channel.send({ kind: 'stop', graceMs: this.scenario.graceMs });
    }
    // Give viewers the grace period plus a little, so a viewer that handles
    // SIGTERM can finish and emit its authoritative summary. The agent SIGKILLs
    // anything still alive when the grace expires, so this wait ends either
    // way — unless an agent has stopped reporting, in which case `active` is a
    // stale number that will never reach zero and the timeout is the only exit.
    await this.waitFor(
      () => this.totalActive() === 0,
      this.scenario.graceMs + 10_000,
      undefined,
    );
  }

  private async collectAll(): Promise<void> {
    this.closeViewerLogs();
    // Only a remote agent has files to ship: a local one writes its viewer logs
    // straight into this run's directory.
    const remote = this.links.filter((link) => link.report.host !== 'local');
    if (remote.length > 0) {
      await mkdir(path.join(this.runDir, 'viewers'), { recursive: true });
      for (const link of remote) {
        link.channel.send({ kind: 'collect' });
      }
      await this.waitFor(
        () => remote.every((link) => link.collectDone),
        COLLECT_TIMEOUT_MS,
        undefined,
      );
    }
    // Every agent is shut down, local ones included. An in-process agent that is
    // never told to shut down keeps its 1 Hz sampler running for the life of the
    // process — invisible in a one-run CLI that exits straight after, and a leak
    // in a session, where each restart leaves another ghost forking `ps` once a
    // second and appending to a finished run's machine log.
    for (const link of this.links) {
      link.collectDone = true;
      link.channel.send({ kind: 'shutdown' });
      link.kill?.();
    }
  }

  /**
   * Mirror one viewer's event stream to `viewers/<id>.ndjson` as it arrives.
   *
   * The agent keeps the authoritative copy on its own disk and `collect` ships
   * it at the end of the run, which is better data — it has the lines this
   * controller may have dropped, and the stderr log beside it. But it only
   * exists if the run reaches its end, and the first real Vultr run did not:
   * six hung viewers held the controller open past its ceiling, and when it was
   * finally killed all 250 viewers' records went with it, having never touched
   * a disk. Every machine sample survived, because those were streamed.
   *
   * So this is the same trade the sampler already makes: write continuously and
   * be overwritten by something better later, rather than hold the only copy in
   * memory until the end.
   */
  private appendViewerLine(viewerId: string, line: string): void {
    let log = this.viewerLogs.get(viewerId);
    if (log === undefined) {
      log = createWriteStream(path.join(this.runDir, 'viewers', `${viewerId}.ndjson`), {
        flags: 'a',
      });
      // A viewer whose log cannot be written must not take the run down with
      // it; the agent's copy is still coming.
      log.on('error', () => this.viewerLogs.delete(viewerId));
      this.viewerLogs.set(viewerId, log);
    }
    log.write(`${line}\n`);
  }

  /**
   * Close the live logs before `collect` replaces them.
   *
   * Writing an agent's authoritative file over a stream this process still has
   * open interleaves the two, which would corrupt exactly the records the live
   * copy exists to protect.
   */
  private closeViewerLogs(): void {
    for (const log of this.viewerLogs.values()) {
      log.end();
    }
    this.viewerLogs.clear();
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
        // Controller-clock, so it can be compared with `Date.now()` without
        // reasoning about which agent's offset applies.
        this.lastViewerStartMs = Date.now();
        break;
      }
      case 'viewer_line': {
        // Written before it is parsed, and regardless of whether it parses: a
        // line this controller could not understand is exactly the line a
        // person will want to read afterwards.
        //
        // Remote links only. A local agent's `outDir` *is* this run directory,
        // so it is already writing this exact file itself; opening it here too
        // would append every line twice.
        if (link.report.host !== 'local') {
          this.appendViewerLine(message.viewerId, message.line);
        }
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
        if (parsed.event.ev === 'joined') {
          // The instant a viewer's `--duration` starts counting: both run modes
          // emit `joined` and then immediately take the playback clock
          // (`main.rs::play_live`, `main.rs::play`). Kept on the controller's
          // own clock, because the straggler bound compares it with `Date.now()`
          // — the viewer's `join_ms` is measured against its own start and, in
          // the mock, against simulated time.
          this.lastViewerJoinMs = Date.now();
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
        link.held = message.held;
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
    const elapsed = (Date.now() - this.measuredFromMs) / 1000;
    return cohortKpis(this.records(), this.requested, elapsed);
  }

  /**
   * Per-viewer peer footprints, for the `peer_target` guard and the ramp stop.
   *
   * `agent` undefined means the whole fleet: the guard judges one box, the
   * connection ceiling is a property of the run. `exitedAtMs` is absent while a
   * viewer is still running, so a lifetime is measured to now — which is what
   * makes this usable live, during a ramp, and not only in the final report.
   */
  private peerAttainmentFor(agent?: string): PeerAttainment[] {
    const now = Date.now();
    return this.records()
      .filter((record) => agent === undefined || record.agent === agent)
      .map((record) => ({
        target: record.peerLimit,
        peak: record.peersMax ?? 0,
        last: record.peersLast ?? 0,
        lifetimeMs: (record.exitedAtMs ?? now) - record.startedAtMs,
        crashed: record.outcome === 'crashed',
      }));
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
        peerAttainment: this.peerAttainmentFor(link.report.name),
        // `port-ceiling` and `flood` exist to find the point where viewers stop
        // getting peers, so there the shortfall is the answer, not a fault.
        peerTargetAdvisory:
          this.scenario.mode === 'port-ceiling' ||
          this.scenario.mode === 'flood' ||
          // A session is a person pushing their own machine until it complains.
          // Viewers that cannot hold their peers are the complaint, and reading
          // it as a broken rig would invalidate every run that found a limit.
          this.scenario.mode === 'session',
        // Only set for a settled run: elsewhere it equals the run's start and
        // scopes nothing.
        ...(this.scenario.settle === undefined ? {} : { measuredFromMs: this.measuredFromMs }),
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
      held: link.held,
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
        held: this.links.reduce((total, link) => total + link.held, 0),
        started: this.totalStarted(),
        exited: this.links.reduce((total, link) => total + link.exited, 0),
        joined: kpis.viewers.joined,
        degradedFraction: kpis.degradedFraction,
        stallRatioP95: kpis.stallRatio.p95,
        realtimeFactorP95: kpis.realtimeFactorP95,
        windowMbps: this.throughput.mbps(Date.now()),
        segments: kpis.segments,
        bytes: kpis.bytes,
        stalls: kpis.stallsTotal,
        peersHeld: kpis.peersTotal,
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

  /**
   * Something that makes a number here mean less than it appears to, but does
   * not make the run worthless. `invalid` is for the latter.
   */
  /**
   * A finding about the quality of the measurement.
   *
   * On a rig it invalidates the run: the whole point of the guards is that the
   * generator's own limits must never be published as Swarm's. On a
   * participant's laptop there is no such number to protect — the machine is
   * someone's daily driver, it was never going to pass a headroom check, and
   * the useful output is the load it put on the network, which happened
   * regardless. So there the same finding is recorded as a caveat and the run
   * still reports success.
   */
  private judge(reason: string): void {
    if (this.scenario.profile === 'participant') {
      this.caveat(reason);
      return;
    }
    this.invalid(reason);
  }

  private caveat(reason: string): void {
    if (!this.observedCaveats.includes(reason)) {
      this.observedCaveats.push(reason);
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
    const settleS = (this.measuredFromMs - this.startedAtMs) / 1000;
    const records = this.records();
    // KPIs are measured from the release, not from the process start: byte and
    // segment rates divided by a window that includes the settle phase would
    // report a throughput no viewer ever saw.
    const kpis = cohortKpis(records, this.requested, (endedAtMs - this.measuredFromMs) / 1000);
    const guards = this.evaluateAllGuards();
    for (const guard of guards.filter((verdict) => verdict.status === 'breached')) {
      this.judge(`guard ${guard.name}: ${guard.detail}`);
    }
    // Every agent is measured against this one controller, so agents that agree
    // on their offset are not the ones with the wrong clock.
    const offsets = this.agents()
      .map((agent) => agent.clockOffsetMs)
      .filter((offset): offset is number => offset !== undefined);
    if (controllerClockSuspect(offsets)) {
      this.judge(
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
        this.judge(
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
      this.judge(
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
      measuredFromMs: this.measuredFromMs,
      endedAtMs,
      durationS,
      settleS,
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
    const caveats: string[] = [...this.scenario.caveats, ...this.observedCaveats];
    if (this.scenario.profile === 'participant') {
      caveats.push(
        "ran on a participant's own machine, not on a rig: preflight was advisory and the " +
          'guards below are recorded rather than enforced. This says how much load this ' +
          'machine put on Swarm; it is not a capacity measurement, and its CPU, memory and ' +
          'bandwidth figures describe a laptop that was also doing other things.',
      );
    }
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

  /**
   * Signal handler path: stop the viewers, and let `run` write the report.
   *
   * It used to tear the agents down here as well — send `shutdown`, close the
   * ssh pipe — which defeated its own purpose twice over. `run` was left
   * blocked in a wait that did not test this flag, so nothing proceeded; and
   * once the pipes were closed there was no agent left to `collect` from, so
   * even if it had proceeded there would have been nothing to collect. What the
   * operator asked for, and what the CLI says on screen, is "stop the viewers
   * and write the report".
   *
   * So the flag is the whole mechanism: every long wait in the run loop tests
   * it, returns, and falls into the ordinary `stopAll` / `collectAll` / report
   * path. The CLI's second signal is the escape hatch if that path itself
   * misbehaves.
   */
  async abort(reason: string): Promise<void> {
    this.aborted = true;
    if (this.scenario.mode === 'session') {
      // A session has no other ending. Someone presses `q`, or Ctrl-C, and the
      // run is over — that is the design, not an interrupted measurement, and
      // marking it invalid would file every complete session as a failure.
      this.caveat(`the session was ended by ${reason}`);
    } else {
      this.invalid(`aborted: ${reason}`);
    }
    this.stoppedBecause = `aborted: ${reason}`;
    await this.stopAll();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
