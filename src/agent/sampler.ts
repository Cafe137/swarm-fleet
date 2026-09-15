/**
 * Resource sampling, once per second, for every viewer on this machine.
 *
 * This is the agent's job rather than the viewer's for two reasons: one `ps`
 * covers 200 processes where 200 self-samplers would each pay their own cost,
 * and every sample then shares a clock, so per-viewer numbers are comparable.
 * The sampler's own lateness is recorded too — a sampler drifting off 1 Hz is
 * the first sign the agent is starved, which is a guard KPI.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';

export interface ProcessSample {
  pid: number;
  rssBytes: number;
  cpuSeconds: number;
}

/**
 * `ps` cumulative CPU time, in seconds.
 *
 * Formats differ by platform and magnitude: `MM:SS.ss` on darwin, and
 * `[[DD-]HH:]MM:SS` on Linux once a process has been up long enough. Returns
 * `undefined` for anything unrecognised rather than guessing, so a parser bug
 * shows up as missing data instead of a plausible wrong number.
 */
export function parseCpuTime(raw: string): number | undefined {
  const text = raw.trim();
  if (text.length === 0) {
    return undefined;
  }
  let days = 0;
  let rest = text;
  const dash = text.indexOf('-');
  if (dash !== -1) {
    days = Number(text.slice(0, dash));
    rest = text.slice(dash + 1);
    if (!Number.isFinite(days)) {
      return undefined;
    }
  }
  const parts = rest.split(':');
  if (parts.length === 0 || parts.length > 3) {
    return undefined;
  }
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) {
      return undefined;
    }
    seconds = seconds * 60 + value;
  }
  return days * 86_400 + seconds;
}

/** `ps -o pid=,rss=,time=` output. Keyed by pid because `ps` reorders. */
export function parsePsOutput(stdout: string): ProcessSample[] {
  const samples: ProcessSample[] = [];
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) {
      continue;
    }
    const pid = Number(fields[0]);
    const rssKib = Number(fields[1]);
    const cpuSeconds = parseCpuTime(fields[2] as string);
    if (!Number.isFinite(pid) || !Number.isFinite(rssKib) || cpuSeconds === undefined) {
      continue;
    }
    samples.push({ pid, rssBytes: rssKib * 1024, cpuSeconds });
  }
  return samples;
}

/**
 * PowerShell's answer to `ps`: `<pid> <resident bytes> <cpu seconds>`.
 *
 * Bytes rather than KiB and a decimal number of seconds rather than a clock
 * face, so it gets its own parser instead of contorting `parsePsOutput`. A pid
 * that has already exited prints nothing, which is the same thing `ps` does.
 */
export function parsePowerShellProcesses(stdout: string): ProcessSample[] {
  const samples: ProcessSample[] = [];
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) {
      continue;
    }
    const pid = Number(fields[0]);
    const rssBytes = Number(fields[1]);
    const cpuSeconds = Number(fields[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(rssBytes) || !Number.isFinite(cpuSeconds)) {
      continue;
    }
    samples.push({ pid, rssBytes, cpuSeconds });
  }
  return samples;
}

export async function sampleProcesses(pids: readonly number[]): Promise<ProcessSample[]> {
  if (pids.length === 0) {
    return [];
  }
  if (process.platform === 'win32') {
    // Fields are stringified one by one against the invariant culture, not
    // formatted with `-f`: that operator uses the *current* culture, so on a
    // German or French Windows the CPU seconds come out as `1,5`, every line
    // fails to parse, and the machine reports no resource samples at all —
    // which on a rig is a guard breach rather than a missing column.
    const stdout = await powershell(
      `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
        // Single quotes throughout, so nothing here depends on how Node
        // escapes a double quote into a Windows command line.
        "ForEach-Object { $_.Id.ToString([cultureinfo]::InvariantCulture) + ' ' + " +
        "$_.WorkingSet64.ToString([cultureinfo]::InvariantCulture) + ' ' + " +
        '$_.TotalProcessorTime.TotalSeconds.ToString([cultureinfo]::InvariantCulture) }',
    );
    return stdout === undefined ? [] : parsePowerShellProcesses(stdout);
  }
  const stdout = await run('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')]);
  return stdout === undefined ? [] : parsePsOutput(stdout);
}

/**
 * Established TCP connections on this machine.
 *
 * Only sampled for the port-ceiling scenario: it is the one measurement that
 * costs enough to perturb what it measures, so it is off by default.
 */
export async function countEstablishedSockets(): Promise<number | undefined> {
  // `netstat -an -p tcp` is spelled the same on darwin and on Windows, and
  // prints ESTABLISHED on a line either way, so only Linux needs its own.
  const stdout =
    process.platform === 'linux'
      ? await run('ss', ['-tan', 'state', 'established'])
      : await run('netstat', ['-an', '-p', 'tcp']);
  if (stdout === undefined) {
    return undefined;
  }
  if (process.platform === 'linux') {
    // One header line.
    return Math.max(0, stdout.trimEnd().split('\n').length - 1);
  }
  return stdout.split('\n').filter((line) => line.includes('ESTABLISHED')).length;
}

export interface MachineReading {
  loadAvg1: number;
  loadAvg5: number;
  freeMemBytes: number;
  agentRssBytes: number;
}

export function readMachine(): MachineReading {
  const load = os.loadavg();
  return {
    loadAvg1: load[0] ?? 0,
    loadAvg5: load[1] ?? 0,
    freeMemBytes: os.freemem(),
    agentRssBytes: process.memoryUsage.rss(),
  };
}

/**
 * A self-correcting 1 Hz timer that reports how late each tick was.
 *
 * `setInterval` would silently swallow the lateness, which is the one thing
 * worth knowing: if the sampler cannot keep 1 Hz, the machine is too loaded for
 * its own measurements to be trusted.
 */
export class Ticker {
  private timer: NodeJS.Timeout | undefined;
  private nextAtMs: number;
  private stopped = false;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: (lagMs: number) => void | Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.nextAtMs = this.now() + intervalMs;
  }

  start(): void {
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    const delay = Math.max(0, this.nextAtMs - this.now());
    this.timer = setTimeout(() => {
      const lag = this.now() - this.nextAtMs;
      this.nextAtMs += this.intervalMs;
      // A tick that ran very late must not queue a burst of catch-up ticks:
      // that would sample the machine we just failed to sample on time.
      if (this.nextAtMs < this.now()) {
        this.nextAtMs = this.now() + this.intervalMs;
      }
      void Promise.resolve(this.tick(lag)).finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }
}

/**
 * One PowerShell command, or `undefined`.
 *
 * Windows has no `ps`, no `/proc` and no `netstat -ib`, and the `wmic` that
 * used to stand in for all three is gone from Windows 11. Every caller here
 * already treats a missing reading as "not measured" — the live view renders it
 * as `-` — so a machine with a locked-down PowerShell loses a column rather
 * than the run.
 */
function powershell(script: string): Promise<string | undefined> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function run(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 5_000, maxBuffer: 8 << 20 }, (error, stdout) => {
      resolve(error !== null && stdout.length === 0 ? undefined : stdout);
    });
  });
}

// ------------------------------------------------------------------ network

/**
 * Cumulative interface byte counters, loopback excluded.
 *
 * Nothing else in the rig measures the wire. `aggregateMbps` is built from
 * viewer-reported *media* bytes, so it cannot see Swarm's retrieval overhead —
 * the requests, the intermediate BMT chunks, the duplicated fetches. These
 * counters are the other half of that ratio, and they are also the only way to
 * tell "the network is the limit" from "the network is fine" on a box whose
 * NIC is shared with everything else on the host.
 *
 * Loopback is excluded on purpose: a publisher running beside the agent would
 * otherwise show up as fleet traffic.
 *
 * Sampled every tick, unlike the socket count. Interface counters do not scale
 * with the number of connections — measured at 1.7 ms of CPU per call on
 * darwin, the same order as the `ps` this already runs, and a free `/proc` read
 * on Linux — whereas counting 8,000 established sockets does, which is why that
 * one stays off by default.
 */
export interface NetworkCounters {
  rxBytes: number;
  txBytes: number;
}

/** `/proc/net/dev`: `iface: rx_bytes rx_packets ... tx_bytes tx_packets ...` */
export function parseProcNetDev(text: string): NetworkCounters | undefined {
  let rxBytes = 0;
  let txBytes = 0;
  let interfaces = 0;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const name = line.slice(0, colon).trim();
    if (name === '' || isLoopback(name)) {
      continue;
    }
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    // Receive block is 8 columns wide, so transmit bytes is the ninth.
    const rx = fields[0];
    const tx = fields[8];
    if (rx === undefined || tx === undefined || !Number.isFinite(rx) || !Number.isFinite(tx)) {
      continue;
    }
    rxBytes += rx;
    txBytes += tx;
    interfaces += 1;
  }
  return interfaces === 0 ? undefined : { rxBytes, txBytes };
}

/**
 * `netstat -ibn` on darwin.
 *
 * Only the `<Link#n>` rows are per-interface totals; the address rows repeat
 * the same counters once per configured address, so summing every row
 * multiplies a dual-stack interface by three. Columns are read from the right
 * because the Address column is blank on exactly the rows we want, which shifts
 * every index when the line is split on whitespace.
 */
export function parseNetstatInterfaces(text: string): NetworkCounters | undefined {
  let rxBytes = 0;
  let txBytes = 0;
  let interfaces = 0;
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 7 || !fields.some((field) => field.startsWith('<Link#'))) {
      continue;
    }
    // A trailing `*` marks an interface that is down. It is still an interface.
    const name = (fields[0] as string).replace(/\*$/, '');
    if (isLoopback(name)) {
      continue;
    }
    const rx = Number(fields[fields.length - 5]);
    const tx = Number(fields[fields.length - 2]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) {
      continue;
    }
    rxBytes += rx;
    txBytes += tx;
    interfaces += 1;
  }
  return interfaces === 0 ? undefined : { rxBytes, txBytes };
}

function isLoopback(name: string): boolean {
  return name === 'lo' || name.startsWith('lo0') || name.startsWith('lo:');
}

/**
 * `Get-NetAdapterStatistics`, one `name|rx|tx` per adapter.
 *
 * The cmdlet does not list the loopback pseudo-interface at all, so there is
 * nothing to exclude here; the filter stays anyway, because a machine with a
 * loopback adapter that *is* listed would otherwise count a local publisher's
 * traffic as fleet traffic.
 */
export function parseNetAdapterStatistics(text: string): NetworkCounters | undefined {
  let rxBytes = 0;
  let txBytes = 0;
  let interfaces = 0;
  for (const line of text.split('\n')) {
    const fields = line.trim().split('|');
    if (fields.length < 3) {
      continue;
    }
    const name = (fields[0] as string).trim();
    if (name === '' || /loopback/i.test(name)) {
      continue;
    }
    const rx = Number(fields[1]);
    const tx = Number(fields[2]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) {
      continue;
    }
    rxBytes += rx;
    txBytes += tx;
    interfaces += 1;
  }
  return interfaces === 0 ? undefined : { rxBytes, txBytes };
}

export async function readNetworkCounters(): Promise<NetworkCounters | undefined> {
  if (process.platform === 'linux') {
    try {
      return parseProcNetDev(await readFile('/proc/net/dev', 'utf8'));
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'win32') {
    const stdout = await powershell(
      "Get-NetAdapterStatistics | ForEach-Object { $_.Name + '|' + " +
        "$_.ReceivedBytes.ToString([cultureinfo]::InvariantCulture) + '|' + " +
        '$_.SentBytes.ToString([cultureinfo]::InvariantCulture) }',
    );
    return stdout === undefined ? undefined : parseNetAdapterStatistics(stdout);
  }
  const stdout = await run('netstat', ['-ibn']);
  return stdout === undefined ? undefined : parseNetstatInterfaces(stdout);
}

/**
 * Turns cumulative counters into a rate.
 *
 * Counters reset when an interface disappears and wrap on 32-bit kernels, so a
 * negative delta is reported as no data rather than as a vast negative rate.
 */
export class RateMeter {
  private lastAtMs: number | undefined;
  private last: NetworkCounters | undefined;

  sample(atMs: number, counters: NetworkCounters | undefined): {
    rxBytesPerSec?: number;
    txBytesPerSec?: number;
  } {
    if (counters === undefined) {
      return {};
    }
    const previous = this.last;
    const previousAt = this.lastAtMs;
    this.last = counters;
    this.lastAtMs = atMs;
    if (previous === undefined || previousAt === undefined || atMs <= previousAt) {
      return {};
    }
    const seconds = (atMs - previousAt) / 1000;
    const rx = (counters.rxBytes - previous.rxBytes) / seconds;
    const tx = (counters.txBytes - previous.txBytes) / seconds;
    if (rx < 0 || tx < 0) {
      return {};
    }
    return { rxBytesPerSec: rx, txBytesPerSec: tx };
  }
}

/**
 * Machine-wide CPU utilisation from `os.cpus()` tick counters.
 *
 * Load average is what the guards use, because it is what a saturated box shows
 * — but it is a 1-minute average and lags a ramp by a minute. Utilisation over
 * the sample interval is what a human watching a ramp needs to see.
 */
export class CpuMeter {
  private lastBusy = 0;
  private lastTotal = 0;
  private primed = false;

  constructor(private readonly cpus: () => os.CpuInfo[] = () => os.cpus()) {}

  /** Fraction of all cores busy since the previous call, or undefined first time. */
  sample(): number | undefined {
    let busy = 0;
    let total = 0;
    for (const cpu of this.cpus()) {
      const times = cpu.times;
      const active = times.user + times.nice + times.sys + times.irq;
      busy += active;
      total += active + times.idle;
    }
    const busyDelta = busy - this.lastBusy;
    const totalDelta = total - this.lastTotal;
    this.lastBusy = busy;
    this.lastTotal = total;
    if (!this.primed) {
      this.primed = true;
      return undefined;
    }
    if (totalDelta <= 0 || busyDelta < 0) {
      return undefined;
    }
    return Math.min(1, busyDelta / totalDelta);
  }
}
