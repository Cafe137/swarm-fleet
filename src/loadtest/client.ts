/**
 * `swarm-fleet join`: one participant in a hand-driven run.
 *
 * This is the whole tool a participant runs. It asks the backend what to watch,
 * fetches the viewer for whatever machine it is on, starts twenty viewers, draws
 * a dashboard, lets two arrow keys change how many are running, and posts a
 * line home every fifteen seconds. There are no flags to get right, because
 * everything that could be a flag is either derived from the machine, a constant
 * in `protocol.ts`, or the one thing the server actually has to say: which
 * stream to watch.
 *
 * Four decisions are worth knowing about:
 *
 * -   **The descriptor limit is raised before anything else happens.** One
 *     viewer needs a little over 200 descriptors, and a macOS terminal has
 *     historically offered 256 in total. Getting this wrong does not look like
 *     a limit; it looks like Swarm being broken.
 * -   **The backend can disappear without stopping the load.** Reports are
 *     best-effort. A participant who cannot reach the scoreboard is still
 *     watching the stream, which is the part that matters — and if the server
 *     comes back not knowing them, they join again rather than quietly
 *     vanishing from the leaderboard while still generating load.
 * -   **A new stream restarts the viewers rather than ending the session.** The
 *     publisher will be restarted at some point during a two-hour event, and
 *     every participant having to notice and retype a command is not a plan.
 * -   **Every way of being asked to stop ends the same way.** A key, a signal,
 *     a closed terminal: the viewers are stopped deliberately. They run in
 *     their own process groups, so anything that skips this leaves hundreds of
 *     mainnet connections open on somebody's machine.
 */

import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Controller, type LiveSnapshot, type RunResult } from '../controller.js';
import { fetchViewerBinaryForPlatform } from '../deploy/github.js';
import { hostPlatform } from '../deploy/platform.js';
import { descriptorsNeeded, ensureDescriptorLimit } from '../limits.js';
import { createRunDir, runId, writeJson } from '../run-dir.js';
import { resolveScenario } from '../scenario.js';
import { Backend, BackendError } from './backend.js';
import { SessionView, type SessionState } from './dashboard.js';
import { configRoot, loadIdentity, saveIdentity } from './identity.js';
import {
  type JoinResponse,
  type LeaderboardRow,
  type FleetTotals,
  LOADTEST_PROTOCOL_VERSION,
  type LoadtestReport,
  PEERS_PER_VIEWER,
  REPORT_INTERVAL_S,
  START_VIEWERS,
  type StreamInfo,
  VIEWER_STEP,
  WARN_ABOVE_VIEWERS,
} from './protocol.js';

/** Viewers to size the descriptor limit against, before the server says more. */
const LIMIT_HEADROOM_VIEWERS = 200;
/** How long a viewer lives before it is retired and replaced. */
const VIEWER_LIFETIME_S = 3_600;
/** Between attempts at a backend that is up but has no stream yet. */
const JOIN_RETRY_MS = 10_000;
/**
 * How long to keep trying before giving up on the address itself.
 *
 * Generous, because the common case is many participants starting within the
 * same minute, while the publisher is still coming up.
 * Not unbounded, because a server that will never answer should say so on
 * screen rather than spin all afternoon.
 */
const JOIN_PATIENCE_MS = 15 * 60_000;
/** Attempts at starting a stretch of watching before giving the laptop back. */
const EPOCH_ATTEMPTS = 3;

export interface JoinOptions {
  server: string;
  /** A local viewer binary, for developing the tool. Otherwise CI's. */
  binary?: string | undefined;
  githubRepo?: string | undefined;
  githubTag?: string | undefined;
  /** Overrides the server's starting viewer count. */
  viewers?: number | undefined;
  runsDir?: string | undefined;
  quiet?: boolean | undefined;
  /** Stops after this long. Only used by the tool's own tests. */
  maxSeconds?: number | undefined;
}

export async function runLoadtestSession(options: JoinOptions): Promise<number> {
  // Before the network, before the binary, before anything that could fail for
  // an interesting reason: this re-executes the process and does not return.
  await ensureDescriptorLimit(descriptorsNeeded(LIMIT_HEADROOM_VIEWERS, PEERS_PER_VIEWER), (message) =>
    process.stderr.write(`${message}\n`),
  );

  const view = new SessionView(options.quiet === true ? { interactive: false } : {});
  const backend = new Backend({ base: options.server });
  const remembered = await loadIdentity(backend.origin);
  const say = (message: string): void => void process.stderr.write(`${message}\n`);

  say(`joining ${backend.origin}`);
  const joined = await joinWithPatience(backend, remembered?.sessionId, say);
  await saveIdentity(backend.origin, { sessionId: joined.sessionId, name: joined.name });

  say(`you are ${joined.name}, watching ${joined.stream.owner.slice(0, 12)}:${joined.stream.topic}`);
  if (joined.motd !== undefined) {
    say(joined.motd);
  }

  const binary =
    options.binary ??
    (
      await fetchViewerBinaryForPlatform(
        {
          platform: hostPlatform(),
          ...(options.githubRepo === undefined ? {} : { repo: options.githubRepo }),
          ...(options.githubTag === undefined ? {} : { tag: options.githubTag }),
        },
        (_level, message) => say(message),
      )
    ).path;

  const session = new Session({
    view,
    backend,
    binary,
    name: joined.name,
    sessionId: joined.sessionId,
    stream: joined.stream,
    startViewers: options.viewers ?? START_VIEWERS,
    runsDir: options.runsDir ?? path.join(configRoot(), 'runs'),
    ...(options.maxSeconds === undefined ? {} : { maxSeconds: options.maxSeconds }),
  });
  return session.run();
}

/**
 * Join, waiting out the reasons a backend is not ready yet.
 *
 * A stream that has not published enough runway to be joinable is the normal
 * state of a load test in its first minute, and the server says so with a 503.
 * Answering "the stream is not up yet, try again in a minute" and exiting would
 * have every participant retyping a command at a slightly different time;
 * waiting here has them all join the moment it is live.
 */
async function joinWithPatience(
  backend: Backend,
  sessionId: string | undefined,
  say: (message: string) => void,
): Promise<JoinResponse> {
  const until = Date.now() + JOIN_PATIENCE_MS;
  let explained = '';
  for (;;) {
    try {
      return await backend.join(joinRequest(sessionId));
    } catch (error) {
      const retryable = error instanceof BackendError && error.retryable;
      const detail = error instanceof Error ? error.message : String(error);
      if (!retryable || Date.now() >= until) {
        // The server's own words when it had any — it knows why it refused, and
        // its message says what to do about it. The hint is for the other case:
        // nothing answered at all, which from here is indistinguishable from an
        // event that has not started yet.
        throw new Error(
          error instanceof BackendError && error.status !== undefined
            ? detail
            : `${detail}\nCheck whether the load test has started.`,
        );
      }
      // Said once per distinct reason: the same line every ten seconds reads
      // like a fault, and the reason does change as the publisher comes up.
      if (detail !== explained) {
        explained = detail;
        say(`waiting for the load test to be ready: ${detail}`);
      }
      await sleep(JOIN_RETRY_MS);
    }
  }
}

function joinRequest(sessionId: string | undefined): Parameters<Backend['join']>[0] {
  return {
    protocol: LOADTEST_PROTOCOL_VERSION,
    client: 'swarm-fleet',
    platform: process.platform,
    arch: process.arch,
    ...(sessionId === undefined ? {} : { sessionId }),
    cores: Math.max(1, os.cpus().length),
    memGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

interface SessionOptions {
  view: SessionView;
  backend: Backend;
  binary: string;
  name: string;
  sessionId: string;
  stream: StreamInfo;
  startViewers: number;
  runsDir: string;
  maxSeconds?: number | undefined;
}

/**
 * One participant's session: viewers, keyboard, dashboard, reports.
 *
 * The viewers live inside a `Controller` in `session` mode, which is restarted
 * when the stream changes. Everything the person sees — totals, the
 * leaderboard, their own place in it — outlives those restarts, so an epoch
 * boundary shows up on screen as the node count dipping and recovering, not as
 * the session ending.
 */
class Session {
  private readonly startedAtMs = Date.now();
  private readonly view: SessionView;
  private readonly backend: Backend;
  private readonly options: SessionOptions;

  /** Both can change mid-session, when the server has to be rejoined. */
  private name: string;
  private sessionId: string;

  private stream: StreamInfo;
  private desiredTarget: number;
  private controller: Controller | undefined;
  private snapshot: LiveSnapshot | undefined;

  /** Totals from epochs that have already finished, so restarts do not reset. */
  private carriedSegments = 0;
  private carriedBytes = 0;
  private carriedStalls = 0;
  private carriedExited = 0;

  private rank: number | undefined;
  private totals: FleetTotals | undefined;
  private leaderboard: readonly LeaderboardRow[] | undefined;
  private offlineSinceMs: number | undefined;
  private quitting = false;
  private restarting = false;
  private rejoining = false;
  private stopKeyboard: (() => void) | undefined;
  private stopSignals: (() => void) | undefined;
  private readonly runDirs: string[] = [];

  constructor(options: SessionOptions) {
    this.options = options;
    this.view = options.view;
    this.backend = options.backend;
    this.name = options.name;
    this.sessionId = options.sessionId;
    this.stream = options.stream;
    this.desiredTarget = options.startViewers;
  }

  async run(): Promise<number> {
    this.stopSignals = this.listenForSignals();
    this.stopKeyboard = this.listenForKeys();
    const painting = setInterval(() => this.paint(), 1_000);
    painting.unref();
    const reporting = setInterval(() => void this.report(false), REPORT_INTERVAL_S * 1_000);
    reporting.unref();
    const deadline =
      this.options.maxSeconds === undefined
        ? undefined
        : setTimeout(() => void this.quit('time limit'), this.options.maxSeconds * 1_000);
    deadline?.unref();

    const results: RunResult[] = [];
    try {
      while (!this.quitting) {
        await this.waitForWork();
        if (this.quitting) {
          break;
        }
        results.push(await this.watchUntilSomethingChanges());
      }
    } finally {
      clearInterval(painting);
      clearInterval(reporting);
      if (deadline !== undefined) {
        clearTimeout(deadline);
      }
      this.stopKeyboard?.();
      this.stopSignals?.();
      await this.report(true);
      this.view.release();
    }

    this.printFarewell(results);
    return 0;
  }

  /**
   * Idle while the participant has asked for nothing to be running.
   *
   * One press of the left arrow from the starting twenty gets here. Starting a
   * viewer anyway — which is what the scenario's "at least one" would do —
   * would put a node on Swarm that nobody asked for and make the screen
   * disagree with itself: nought asked for, one running.
   */
  private async waitForWork(): Promise<void> {
    if (this.desiredTarget >= 1) {
      return;
    }
    this.view.log('nothing running; press the right arrow when you want nodes again');
    while (!this.quitting && this.desiredTarget < 1) {
      await sleep(200);
    }
  }

  /**
   * One stretch of watching, and what to do if it cannot start.
   *
   * A failure here is not the same as a participant stopping. The session is
   * meant to survive a two-hour call, and the things that can go wrong between
   * two stretches — a wiped cache directory, a full disk — are worth a few
   * attempts before giving somebody's laptop back to them. Consecutive failures
   * are counted, though: a setup that is genuinely broken should say so and
   * exit rather than retry all afternoon.
   */
  private async watchUntilSomethingChanges(): Promise<RunResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.runEpoch();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (attempt >= EPOCH_ATTEMPTS || this.quitting) {
          throw new Error(`could not start your nodes (${detail})`);
        }
        this.view.log(`could not start your nodes (${detail}); trying again in 5s`);
        await sleep(5_000);
      }
    }
  }

  /** One stretch of watching, ending when the session or the stream does. */
  private async runEpoch(): Promise<RunResult> {
    const scenario = resolveScenario({
      mode: 'session',
      profile: 'participant',
      label: `join-${this.name}`,
      binary: this.options.binary,
      streams: [{ owner: this.stream.owner, topic: this.stream.topic }],
      network: this.stream.network,
      live: true,
      viewers: Math.max(1, this.desiredTarget),
      peerLimit: PEERS_PER_VIEWER,
      durationS: VIEWER_LIFETIME_S,
      runsDir: this.options.runsDir,
      // A participant's own machine: the numbers are the load it generated, and
      // they are reported rather than being judged against a rig's headroom.
      countSockets: false,
    });
    const id = runId(scenario.label);
    const dir = await createRunDir(scenario.runsDir, id);
    this.runDirs.push(dir);

    const controller = new Controller(scenario, id, dir, {
      onSnapshot: (snapshot) => {
        this.snapshot = snapshot;
      },
      onLog: (level, message) => {
        if (level !== 'info') {
          this.view.log(`${level}: ${message}`);
        }
      },
    });
    this.controller = controller;
    this.restarting = false;

    const result = await controller.run(false);
    // Whatever this epoch did is kept, because the next one starts from zero —
    // and it is taken from the run's own KPIs rather than from the last live
    // snapshot, which is up to a second stale and predates the summaries every
    // viewer emits as it stops. The difference is small and it is in the number
    // this participant is ranked by, so it may as well be right.
    this.carriedSegments += result.kpis.segments;
    this.carriedBytes += result.kpis.bytes;
    this.carriedStalls += result.kpis.stallsTotal;
    this.carriedExited += result.kpis.viewers.started;
    this.snapshot = undefined;
    this.controller = undefined;
    await writeJson(path.join(dir, 'result.json'), {
      valid: result.valid,
      stoppedBecause: result.stoppedBecause,
      kpis: result.kpis,
    });
    return result;
  }

  // ------------------------------------------------------------- keyboard

  /**
   * Two arrows and a letter.
   *
   * Raw mode means Ctrl-C no longer arrives as a signal, so it is handled here
   * as a keypress — missing that would leave a participant unable to stop 200
   * viewers except by closing the window.
   *
   * A terminal is not guaranteed: the tool can be run from a script or with its
   * output piped to a file, and then there are no keys, only signals.
   */
  private listenForKeys(): () => void {
    const input = process.stdin;
    if (input.isTTY !== true) {
      this.view.log(
        'no keyboard here (stdin is not a terminal), so the node count stays where it is',
      );
      return () => undefined;
    }

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const onKey = (_chunk: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (key === undefined) {
        return;
      }
      if (key.name === 'right' || key.name === 'up' || key.name === '=') {
        this.nudge(VIEWER_STEP);
      } else if (key.name === 'left' || key.name === 'down' || key.name === '-') {
        this.nudge(-VIEWER_STEP);
      } else if (key.name === 'q' || key.name === 'escape' || (key.ctrl === true && key.name === 'c')) {
        void this.quit('you');
      }
    };
    input.on('keypress', onKey);
    return () => {
      input.off('keypress', onKey);
      if (input.isTTY === true) {
        input.setRawMode(false);
      }
      input.pause();
    };
  }

  /**
   * Every other way of being told to stop.
   *
   * Registered whether or not there is a keyboard, because the viewers are
   * detached process groups: a `kill`, a closed terminal window (SIGHUP) or a
   * laptop being shut down would otherwise leave twenty viewers holding four
   * thousand mainnet connections with nothing left to stop them.
   */
  private listenForSignals(): () => void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const onSignal = (signal: NodeJS.Signals): void => void this.quit(`a ${signal}`);
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
      const handler = (): void => onSignal(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    return () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };
  }

  private nudge(by: number): void {
    if (this.quitting) {
      return;
    }
    this.desiredTarget = Math.max(0, this.desiredTarget + by);
    const applied = this.controller?.setViewerTarget(this.desiredTarget);
    if (applied !== undefined && applied !== this.desiredTarget) {
      // The machine's own ceiling, not a refusal to try.
      this.desiredTarget = applied;
    }
    this.paint();
  }

  private async quit(who: string): Promise<void> {
    if (this.quitting) {
      return;
    }
    this.quitting = true;
    this.view.log(`stopping (${who}); your nodes are being shut down cleanly`);
    this.paint();
    await this.controller?.abort(who);
  }

  // --------------------------------------------------------------- server

  private async report(leaving: boolean): Promise<void> {
    const snapshot = this.snapshot;
    const report: LoadtestReport = {
      sessionId: this.sessionId,
      atMs: Date.now(),
      uptimeS: (Date.now() - this.startedAtMs) / 1000,
      viewers: snapshot?.active ?? 0,
      targetViewers: this.desiredTarget,
      bootstrapping: snapshot?.bootstrapping ?? 0,
      mediaMbps: snapshot?.windowMbps ?? 0,
      segments: this.carriedSegments + (snapshot?.segments ?? 0),
      bytes: this.carriedBytes + (snapshot?.bytes ?? 0),
      stalls: this.carriedStalls + (snapshot?.stalls ?? 0),
      exited: this.carriedExited + (snapshot?.exited ?? 0),
      leaving,
      ...optional('degradedFraction', snapshot?.degradedFraction),
      ...optional('realtimeFactorP95', snapshot?.realtimeFactorP95),
      ...optional('peersHeld', snapshot?.peersHeld),
      ...optional('cpuUtilisation', worst(snapshot, (agent) => agent.cpuUtilisation)),
      ...optional('memUsedFraction', worst(snapshot, (agent) => agent.memUsedFraction)),
      ...optional('wireRxMbps', total(snapshot, (agent) => agent.rxMbps)),
      ...optional('wireTxMbps', total(snapshot, (agent) => agent.txMbps)),
    };

    const outcome = await this.backend.report(report);
    if (outcome.kind === 'rejoin') {
      await this.rejoin();
      return;
    }
    if (outcome.kind === 'unreachable') {
      this.offlineSinceMs ??= Date.now();
      return;
    }
    if (this.offlineSinceMs !== undefined) {
      this.view.log('back in touch with the server');
      this.offlineSinceMs = undefined;
    }
    const answer = outcome.response;
    this.totals = answer.totals;
    this.leaderboard = answer.leaderboard;
    this.rank = answer.rank;
    this.applyStream(answer.stream);
  }

  /**
   * Introduce ourselves again, because the server does not know us any more.
   *
   * What this looks like in practice is the backend being restarted against a
   * fresh data directory half an hour into an event. The viewers here are still
   * watching and still costing Swarm exactly what they did a second ago, so the
   * one thing that must not happen is this client deciding it is offline: the
   * load would carry on and the measurement of it would stop.
   */
  private async rejoin(): Promise<void> {
    if (this.rejoining || this.quitting) {
      return;
    }
    this.rejoining = true;
    try {
      const joined = await this.backend.join(joinRequest(this.sessionId));
      const renamed = joined.name !== this.name;
      this.sessionId = joined.sessionId;
      this.name = joined.name;
      await saveIdentity(this.backend.origin, {
        sessionId: joined.sessionId,
        name: joined.name,
      });
      this.view.log(
        renamed
          ? `the server restarted; you are now ${joined.name}`
          : 'the server restarted; rejoined with the same name',
      );
      this.offlineSinceMs = undefined;
      this.applyStream(joined.stream);
    } catch {
      // Still nothing there. The next report tries again; the nodes keep going.
      this.offlineSinceMs ??= Date.now();
    } finally {
      this.rejoining = false;
    }
  }

  /**
   * Follow the publisher if it moves.
   *
   * A restarted publisher writes to a fresh topic, and a viewer pointed at the
   * old one would sit there politely watching nothing. Restarting the epoch
   * puts everyone back on the live stream within a report interval, with the
   * target they had before.
   */
  private applyStream(next: StreamInfo): void {
    if (this.quitting || this.restarting) {
      return;
    }
    if (next.owner === '' || next.topic === '') {
      // The server has no stream to name yet — the publisher is being
      // restarted. Ours keeps watching the old one until there is a new one to
      // move to, which is better than tearing down for a placeholder.
      return;
    }
    if (next.owner === this.stream.owner && next.topic === this.stream.topic) {
      return;
    }
    this.stream = next;
    this.restarting = true;
    this.view.log('the stream changed; restarting your nodes on the new one');
    void this.controller?.abort('the stream changed');
  }

  // --------------------------------------------------------------- screen

  private paint(): void {
    const snapshot = this.snapshot;
    const state: SessionState = {
      name: this.name,
      elapsedS: (Date.now() - this.startedAtMs) / 1000,
      viewers: snapshot?.active ?? 0,
      target: this.desiredTarget,
      bootstrapping: snapshot?.bootstrapping ?? 0,
      step: VIEWER_STEP,
      mediaMbps: snapshot?.windowMbps ?? 0,
      segments: this.carriedSegments + (snapshot?.segments ?? 0),
      bytes: this.carriedBytes + (snapshot?.bytes ?? 0),
      stalls: this.carriedStalls + (snapshot?.stalls ?? 0),
      warnings: this.warnings(),
      stopping: this.quitting,
      ...optional('degradedFraction', snapshot?.degradedFraction),
      ...optional('peersHeld', snapshot?.peersHeld),
      ...optional('cpuUtilisation', worst(snapshot, (agent) => agent.cpuUtilisation)),
      ...optional('memUsedFraction', worst(snapshot, (agent) => agent.memUsedFraction)),
      ...optional('rxMbps', total(snapshot, (agent) => agent.rxMbps)),
      ...optional('txMbps', total(snapshot, (agent) => agent.txMbps)),
      ...optional('rank', this.rank),
      ...optional('totals', this.totals),
      ...optional('leaderboard', this.leaderboard),
      ...optional('offlineSinceMs', this.offlineSinceMs),
    };
    this.view.render(state);
  }

  /**
   * What is worth interrupting someone for.
   *
   * Only three things, and each one is actionable. Everything else the rig
   * would normally complain about — a busy laptop, a machine that is not idle,
   * a viewer that fell behind — is expected here and says nothing a participant
   * can act on.
   */
  private warnings(): string[] {
    const warnings: string[] = [];
    const snapshot = this.snapshot;
    const viewers = snapshot?.active ?? 0;
    if (viewers > WARN_ABOVE_VIEWERS) {
      warnings.push(
        `${viewers} nodes is ${viewers * PEERS_PER_VIEWER} connections from this machine. ` +
          'Home routers give up well before a rented server does — if your internet drops, ' +
          'this is why. Press the left arrow to back off.',
      );
    }
    // Their own footprint, not the machine's free memory. `os.freemem()` on
    // macOS reports a few hundred megabytes on an idle laptop, so a warning
    // keyed to it would be permanent and therefore useless.
    const held = worst(snapshot, (agent) => agent.memUsedFraction);
    if (held !== undefined && held > 0.5) {
      warnings.push(
        `your nodes are holding ${Math.round(held * 100)}% of this machine's memory; ` +
          'past about half, everything else on it starts to suffer',
      );
    }
    if ((snapshot?.degradedFraction ?? 0) >= 0.25) {
      warnings.push(
        'a quarter of your nodes are stalling. That may be Swarm, or it may be this ' +
          'machine — either way, it is the interesting part of the test.',
      );
    }
    return warnings;
  }

  private printFarewell(results: readonly RunResult[]): void {
    const segments = this.carriedSegments;
    const bytes = this.carriedBytes;
    const minutes = (Date.now() - this.startedAtMs) / 60_000;
    process.stdout.write(
      `\n${this.name}: ${segments.toLocaleString('en-US')} segments, ` +
        `${(bytes / 1024 ** 3).toFixed(2)} GB pulled from Swarm over ${minutes.toFixed(0)} minutes ` +
        `across ${results.length} run${results.length === 1 ? '' : 's'}.\n` +
        `Thank you. Details: ${this.runDirs[this.runDirs.length - 1] ?? 'none'}\n`,
    );
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** The worst of a machine's readings; a session has exactly one machine. */
function worst(
  snapshot: LiveSnapshot | undefined,
  pick: (agent: LiveSnapshot['agents'][number]) => number | undefined,
): number | undefined {
  const values = (snapshot?.agents ?? []).map(pick).filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

function total(
  snapshot: LiveSnapshot | undefined,
  pick: (agent: LiveSnapshot['agents'][number]) => number | undefined,
): number | undefined {
  const values = (snapshot?.agents ?? []).map(pick).filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
