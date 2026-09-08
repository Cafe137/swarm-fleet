/**
 * The agent owns one machine's viewers.
 *
 * The controller says how many viewers it wants; the agent decides when they
 * may actually start, because only the agent can see the machine's CPU. That
 * split matters: admission control is a property of the box, and a controller
 * pacing starts from another continent would be pacing against the wrong load.
 *
 * The agent forwards raw viewer lines rather than parsed events, so the
 * controller's rollup is authoritative and nothing is lost in translation. It
 * does parse lines locally, with the same module, for one purpose only: knowing
 * when a viewer has stopped bootstrapping so the CPU budget can be freed.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Channel } from '../transport/channel.js';
import type {
  AdmissionConfig,
  FromAgent,
  MachineInfo,
  StreamRef,
  ToAgent,
  ViewerSample,
  ViewerSpec,
} from '../transport/protocol.js';
import { AdmissionGate, CostModel } from '../schedule.js';
import { parseViewerEvent } from '../viewer/contract.js';
import { launchViewer, type ViewerHandle } from '../viewer/spawn.js';
import { machineInfo, preflight } from './preflight.js';
import {
  countEstablishedSockets,
  CpuMeter,
  RateMeter,
  readMachine,
  readNetworkCounters,
  sampleProcesses,
  Ticker,
} from './sampler.js';

const FILE_CHUNK_BYTES = 512 * 1024;
const LAUNCH_POLL_MS = 50;

interface TrackedViewer {
  handle: ViewerHandle;
  startedAtMs: number;
  joined: boolean;
  lastCpuSeconds?: number | undefined;
  lastSampleAtMs?: number | undefined;
}

export class FleetAgent {
  private readonly viewers = new Map<string, TrackedViewer>();
  private readonly costs = new CostModel();
  private readonly cpuMeter = new CpuMeter();
  private readonly netMeter = new RateMeter();
  private machine: MachineInfo | undefined;
  private gate: AdmissionGate | undefined;
  private ticker: Ticker | undefined;
  private spec: ViewerSpec | undefined;
  private admission: AdmissionConfig | undefined;
  private outDir = '.';
  private name = os.hostname();
  private agentIndex = 0;
  private maxViewers = 0;
  private target = 0;
  private totalStarts = 0;
  private started = 0;
  private exited = 0;
  private stopping = false;
  private launchTimer: NodeJS.Timeout | undefined;
  private lastAdmissionReason: string | undefined;

  constructor(private readonly channel: Channel<FromAgent, ToAgent>) {}

  async start(): Promise<void> {
    this.machine = await machineInfo();
    this.channel.onMessage((message) => {
      void this.handle(message).catch((error: unknown) => {
        this.log('error', error instanceof Error ? error.message : String(error));
      });
    });
    this.channel.onClose(() => {
      // The controller is gone. Take the viewers with us rather than leaving
      // 200 mainnet connections per viewer running unattended.
      this.killEverything();
    });
    this.channel.send({
      kind: 'hello',
      agent: this.name,
      machine: this.machine,
      agentClockMs: Date.now(),
      version: '0.1.0',
    });
  }

  private async handle(message: ToAgent): Promise<void> {
    switch (message.kind) {
      case 'configure':
        await this.configure(message);
        break;
      case 'set_target':
        this.target = message.concurrent;
        this.totalStarts = message.totalStarts;
        this.pokeLauncher(0);
        this.reportState();
        break;
      case 'stop':
        this.stop(message.graceMs);
        break;
      case 'collect':
        await this.collect();
        break;
      case 'shutdown':
        this.killEverything();
        this.channel.close();
        break;
      case 'ping':
        this.channel.send({ kind: 'pong', agent: this.name, id: message.id, agentClockMs: Date.now() });
        break;
    }
  }

  private async configure(message: Extract<ToAgent, { kind: 'configure' }>): Promise<void> {
    const machine = this.machine ?? (await machineInfo());
    this.machine = machine;
    this.name = message.agentName;
    this.agentIndex = message.agentIndex;
    this.outDir = message.outDir;
    this.spec = message.spec;
    this.admission = message.admission;
    this.maxViewers = message.maxViewers;

    await mkdir(path.join(this.outDir, 'viewers'), { recursive: true });

    const report = await preflight({
      machine,
      maxViewers: message.maxViewers,
      peerLimit: message.spec.peerLimit ?? 200,
      binary: message.spec.binary,
    });
    this.channel.send({ kind: 'ready', agent: this.name, preflight: report });

    this.gate = new AdmissionGate(machine.cores, message.admission, this.costs);
    this.ticker = new Ticker(message.sampleIntervalMs, (lagMs) =>
      this.sample(lagMs, message.countSockets),
    );
    this.ticker.start();
  }

  // ------------------------------------------------------------- launching

  private pokeLauncher(delayMs: number): void {
    if (this.launchTimer !== undefined) {
      return;
    }
    this.launchTimer = setTimeout(() => {
      this.launchTimer = undefined;
      this.tryLaunch();
    }, delayMs);
    this.launchTimer.unref();
  }

  private tryLaunch(): void {
    const gate = this.gate;
    const spec = this.spec;
    if (gate === undefined || spec === undefined || this.stopping) {
      return;
    }
    const wanted = Math.min(this.target, this.maxViewers);
    if (this.viewers.size >= wanted) {
      return;
    }
    // The total cap is what stops a bounded cohort from being relaunched as its
    // viewers finish, and stops a viewer that crashes on startup from being
    // retried thousands of times.
    if (this.started >= this.totalStarts) {
      if (this.viewers.size < wanted) {
        this.lastAdmissionReason = `start budget spent (${this.started} of ${this.totalStarts})`;
        this.reportState();
      }
      return;
    }

    const now = Date.now();
    const decision = gate.decide(now, this.admissionState(now));
    this.lastAdmissionReason = decision.admit ? undefined : decision.reason;
    if (!decision.admit) {
      this.pokeLauncher(Math.max(decision.retryAfterMs, LAUNCH_POLL_MS));
      this.reportState();
      return;
    }

    this.launchOne(spec, now);
    gate.noteStart(now);
    // One per pass, so the minimum interval is actually applied.
    this.pokeLauncher(LAUNCH_POLL_MS);
  }

  private launchOne(spec: ViewerSpec, nowMs: number): void {
    const ordinal = this.started;
    this.started += 1;
    const viewerId = `${this.name}-${String(ordinal).padStart(4, '0')}`;
    const stream = this.assignStream(spec, ordinal);

    const handle = launchViewer(
      { viewerId, spec, stream, outDir: path.join(this.outDir, 'viewers') },
      {
        onLine: (id, line) => this.onViewerLine(id, line),
        onOversizeLine: (id, bytes) =>
          this.log('warn', `${id}: dropped a ${bytes} byte stdout line`),
        onExit: (id, code, signal, requested) => this.onViewerExit(id, code, signal, requested),
        onSpawnError: (id, error) => this.log('error', `${id}: ${error}`),
      },
    );

    this.viewers.set(viewerId, { handle, startedAtMs: nowMs, joined: false });
    this.channel.send({
      kind: 'viewer_started',
      agent: this.name,
      viewerId,
      pid: handle.pid,
      owner: stream.owner,
      topic: stream.topic,
      peerLimit: spec.peerLimit ?? 0,
      live: spec.live,
      agentClockMs: nowMs,
    });
    this.reportState();
  }

  /**
   * Which stream this viewer watches.
   *
   * The agent index enters the offset so that a fleet round-robining over three
   * streams does not put every machine's viewer 0 on the same one.
   */
  private assignStream(spec: ViewerSpec, ordinal: number): StreamRef {
    const streams = spec.streams;
    if (spec.assignment === 'all' || streams.length === 1) {
      return streams[0] as StreamRef;
    }
    return streams[(this.agentIndex + ordinal) % streams.length] as StreamRef;
  }

  private admissionState(nowMs: number): { bootstrapping: number; running: number } {
    const timeout = this.admission?.bootstrapTimeoutMs ?? 15_000;
    let bootstrapping = 0;
    for (const viewer of this.viewers.values()) {
      if (!viewer.joined && nowMs - viewer.startedAtMs < timeout) {
        bootstrapping += 1;
      }
    }
    return { bootstrapping, running: this.viewers.size - bootstrapping };
  }

  // ------------------------------------------------------------- viewer io

  private onViewerLine(viewerId: string, line: string): void {
    const viewer = this.viewers.get(viewerId);
    if (viewer !== undefined && !viewer.joined) {
      const parsed = parseViewerEvent(line);
      // `segment` as well as `joined`: a VOD viewer never joins a live edge but
      // is plainly past bootstrap once it is pulling bodies.
      if (parsed.ok && (parsed.event.ev === 'joined' || parsed.event.ev === 'segment')) {
        viewer.joined = true;
        this.pokeLauncher(0);
      }
    }
    this.channel.send({ kind: 'viewer_line', agent: this.name, viewerId, line });
  }

  private onViewerExit(
    viewerId: string,
    code: number | null,
    signal: string | null,
    requested: boolean,
  ): void {
    this.viewers.delete(viewerId);
    this.exited += 1;
    this.channel.send({
      kind: 'viewer_exited',
      agent: this.name,
      viewerId,
      code,
      signal,
      requested,
      agentClockMs: Date.now(),
    });
    this.reportState();
    if (!this.stopping) {
      // A viewer that finished or died frees budget for the next one.
      this.pokeLauncher(0);
    }
  }

  // ------------------------------------------------------------- sampling

  private async sample(lagMs: number, countSockets: boolean): Promise<void> {
    const machine = this.machine;
    if (machine === undefined) {
      return;
    }
    const entries = [...this.viewers.entries()].filter(([, viewer]) => viewer.handle.pid > 0);
    const pids = entries.map(([, viewer]) => viewer.handle.pid);
    const [processes, sockets, network] = await Promise.all([
      sampleProcesses(pids),
      countSockets ? countEstablishedSockets() : Promise.resolve(undefined),
      readNetworkCounters(),
    ]);
    const byPid = new Map(processes.map((sample) => [sample.pid, sample]));

    const now = Date.now();
    const viewerSamples: ViewerSample[] = [];
    let rssTotal = 0;
    let vcpuTotal = 0;
    let vcpuObserved = false;
    const timeout = this.admission?.bootstrapTimeoutMs ?? 15_000;

    for (const [viewerId, viewer] of entries) {
      const sample = byPid.get(viewer.handle.pid);
      if (sample === undefined) {
        continue;
      }
      rssTotal += sample.rssBytes;
      viewerSamples.push({ viewerId, rssBytes: sample.rssBytes, cpuSeconds: sample.cpuSeconds });

      // Feed the cost model, so the CPU budget stops relying on M1 priors as
      // soon as this machine has told us what a viewer really costs here.
      const lastCpu = viewer.lastCpuSeconds;
      const lastAt = viewer.lastSampleAtMs;
      if (lastCpu !== undefined && lastAt !== undefined && now > lastAt) {
        const vcpu = (sample.cpuSeconds - lastCpu) / ((now - lastAt) / 1000);
        const bootstrapping = !viewer.joined && now - viewer.startedAtMs < timeout;
        this.costs.observe(bootstrapping ? 'bootstrap' : 'steady', vcpu);
        vcpuTotal += vcpu;
        vcpuObserved = true;
      }
      viewer.lastCpuSeconds = sample.cpuSeconds;
      viewer.lastSampleAtMs = now;
    }

    const reading = readMachine();
    const cpuUtilisation = this.cpuMeter.sample();
    const rates = this.netMeter.sample(now, network);
    this.channel.send({
      kind: 'samples',
      agent: this.name,
      machine: {
        atMs: now,
        loadAvg1: reading.loadAvg1,
        loadAvg5: reading.loadAvg5,
        freeMemBytes: reading.freeMemBytes,
        agentRssBytes: reading.agentRssBytes,
        samplerLagMs: lagMs,
        viewerRssTotalBytes: rssTotal,
        ...(sockets === undefined ? {} : { establishedSockets: sockets }),
        ...(cpuUtilisation === undefined ? {} : { cpuUtilisation }),
        ...(vcpuObserved ? { viewerVcpuTotal: vcpuTotal } : {}),
        ...(network === undefined ? {} : { rxBytes: network.rxBytes, txBytes: network.txBytes }),
        ...rates,
      },
      viewers: viewerSamples,
    });
    // `bootstrapping` decays with the wall clock — a viewer stops counting once
    // it joins or once the bootstrap timeout passes — so a state reported only
    // when a viewer starts or exits goes stale the moment launching finishes,
    // and the live view showed a fleet that had long since joined as still
    // bootstrapping. The sampler ticks anyway; report from it.
    this.reportState();
  }

  // ------------------------------------------------------------- lifecycle

  private stop(graceMs: number): void {
    this.stopping = true;
    if (this.launchTimer !== undefined) {
      clearTimeout(this.launchTimer);
      this.launchTimer = undefined;
    }
    for (const viewer of this.viewers.values()) {
      viewer.handle.stop(graceMs);
    }
    this.reportState();
  }

  private killEverything(): void {
    this.stopping = true;
    this.ticker?.stop();
    for (const viewer of this.viewers.values()) {
      viewer.handle.stop(2_000);
    }
  }

  private async collect(): Promise<void> {
    const dir = path.join(this.outDir, 'viewers');
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      files = [];
    }
    for (const file of files) {
      const full = path.join(dir, file);
      const relative = path.join('viewers', file);
      let content: Buffer;
      try {
        content = await readFile(full);
      } catch {
        continue;
      }
      this.channel.send({ kind: 'file_begin', agent: this.name, path: relative });
      for (let at = 0; at < content.length; at += FILE_CHUNK_BYTES) {
        this.channel.send({
          kind: 'file_chunk',
          agent: this.name,
          path: relative,
          base64: content.subarray(at, at + FILE_CHUNK_BYTES).toString('base64'),
        });
      }
      this.channel.send({ kind: 'file_end', agent: this.name, path: relative });
    }
    this.channel.send({ kind: 'collected', agent: this.name, files: files.length });
  }

  private reportState(): void {
    const state = this.admissionState(Date.now());
    this.channel.send({
      kind: 'state',
      agent: this.name,
      target: this.target,
      totalStarts: this.totalStarts,
      startsExhausted: this.started >= this.totalStarts,
      active: this.viewers.size,
      bootstrapping: state.bootstrapping,
      started: this.started,
      exited: this.exited,
      ...(this.lastAdmissionReason === undefined
        ? {}
        : { admissionReason: this.lastAdmissionReason }),
    });
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.channel.send({ kind: 'log', agent: this.name, level, message });
  }
}
