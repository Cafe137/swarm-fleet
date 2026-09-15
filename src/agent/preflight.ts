/**
 * Preflight: refuse to produce numbers a machine cannot support.
 *
 * Every check here has already cost someone a run somewhere. The file
 * descriptor limit is the sharpest: one viewer holds 200 peer connections, so a
 * Linux box's default 1024 soft limit is enough for four viewers, and the
 * failure presents as a network problem rather than as a limit.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MachineInfo, PreflightCheck, PreflightReport } from '../transport/protocol.js';
import { MOCK_BINARY } from '../viewer/spawn.js';

/** Per-viewer costs from CLAUDE.md, used to size a machine before loading it. */
export const VIEWER_RSS_BYTES = 35 * 1024 * 1024;
export const VIEWER_STEADY_VCPU = 0.03;
/** Descriptors a viewer needs beyond its peers: DNS, files, the odd pipe. */
const FD_SLACK_PER_VIEWER = 32;
const FD_AGENT_RESERVE = 256;

export async function machineInfo(): Promise<MachineInfo> {
  const [portRange, fdLimit] = await Promise.all([ephemeralPortRange(), fileDescriptorLimit()]);
  const info: MachineInfo = {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    nodeVersion: process.version,
  };
  const model = os.cpus()[0]?.model;
  return {
    ...info,
    ...(model === undefined ? {} : { cpuModel: model }),
    ...(portRange === undefined
      ? {}
      : { portRangeFirst: portRange.first, portRangeLast: portRange.last }),
    ...(fdLimit === undefined ? {} : { fileDescriptorLimit: fdLimit }),
  };
}

export interface PreflightRequest {
  machine: MachineInfo;
  maxViewers: number;
  peerLimit: number;
  binary: string;
  /**
   * Who is asking, and therefore what a failed check means.
   *
   * `rig` is the default and the historical behaviour: this machine exists to
   * produce a capacity number, so a check it fails is a reason to refuse — a
   * measurement taken on a box that cannot support the load is worse than no
   * measurement.
   *
   * `participant` is somebody's own machine, not a rig. It will never
   * be idle, it may well be short of memory, and nobody is going to publish its
   * numbers as Swarm's capacity. Refusing there would only mean one fewer
   * viewer on the network, which is the opposite of the point. So every check
   * still runs and is still reported — the dashboard shows them — but none of
   * them is fatal.
   */
  profile?: PreflightProfile | undefined;
}

export type PreflightProfile = 'rig' | 'participant';

export async function preflight(request: PreflightRequest): Promise<PreflightReport> {
  const { machine, maxViewers, peerLimit, binary } = request;
  const checks: PreflightCheck[] = [];

  checks.push(fileDescriptorCheck(machine, maxViewers, peerLimit));
  checks.push(memoryCheck(machine, maxViewers));
  checks.push(cpuCheck(machine, maxViewers));
  checks.push(idleCheck(machine, binary === MOCK_BINARY));
  checks.push(portCheck(machine, maxViewers, peerLimit));

  const binaryCheck = await checkBinary(binary);
  checks.push(binaryCheck.check);

  // The binary check is the one exception: with nothing to execute there is no
  // run to have an opinion about, on any machine.
  const advisory = request.profile === 'participant';
  const judged = advisory
    ? checks.map((check) =>
        check.name === 'binary' || !check.fatal
          ? check
          : { ...check, fatal: false, detail: `${check.detail} (advisory: this is a participant's own machine)` },
      )
    : checks;

  const gitSha = binaryCheck.path === undefined ? undefined : await weeb3GitSha(binaryCheck.path);

  return {
    ok: judged.every((check) => check.ok || !check.fatal),
    checks: judged,
    ...(binaryCheck.sha256 === undefined ? {} : { binarySha256: binaryCheck.sha256 }),
    ...(binaryCheck.path === undefined ? {} : { binaryPath: binaryCheck.path }),
    ...(gitSha === undefined ? {} : { weeb3GitSha: gitSha }),
  };
}

function fileDescriptorCheck(
  machine: MachineInfo,
  maxViewers: number,
  peerLimit: number,
): PreflightCheck {
  const needed = maxViewers * (peerLimit + FD_SLACK_PER_VIEWER) + FD_AGENT_RESERVE;
  const limit = machine.fileDescriptorLimit;
  if (limit === undefined) {
    return {
      name: 'file_descriptors',
      ok: true,
      fatal: false,
      detail: 'could not read the descriptor limit; if dials fail, check `ulimit -n` first',
    };
  }
  // Per-process on POSIX, but the agent shares the limit with its children's
  // inherited soft limit, so size it for the whole machine's worth.
  return {
    name: 'file_descriptors',
    ok: limit >= needed,
    fatal: true,
    value: String(limit),
    detail:
      limit >= needed
        ? `ulimit -n ${limit}, need ~${needed} for ${maxViewers} viewers at ${peerLimit} peers`
        : `ulimit -n ${limit} is below the ~${needed} needed for ${maxViewers} viewers at ${peerLimit} peers; raise it or dials will fail in a way that looks like a network problem`,
  };
}

function memoryCheck(machine: MachineInfo, maxViewers: number): PreflightCheck {
  const needed = maxViewers * VIEWER_RSS_BYTES;
  const usable = machine.totalMemBytes * 0.8;
  return {
    name: 'memory',
    ok: needed <= usable,
    fatal: true,
    value: `${mib(needed)} of ${mib(machine.totalMemBytes)}`,
    detail: `${maxViewers} viewers at ~${mib(VIEWER_RSS_BYTES)} needs ${mib(needed)}; 80% of this machine is ${mib(usable)}`,
  };
}

function cpuCheck(machine: MachineInfo, maxViewers: number): PreflightCheck {
  const needed = maxViewers * VIEWER_STEADY_VCPU;
  return {
    name: 'cpu',
    ok: needed <= machine.cores * 0.7,
    fatal: false,
    value: `${needed.toFixed(2)} vCPU of ${machine.cores}`,
    detail: `steady-state estimate at ~${VIEWER_STEADY_VCPU} vCPU per viewer; budget 1.5-2.5x more on an x86 hyperthread than on the M1 these figures came from`,
  };
}

/**
 * Is this machine quiet enough to measure on?
 *
 * Fatal for a real run: whatever else is on the box lands in the stall figures,
 * and a stall caused by someone's build is indistinguishable in the output from
 * a stall caused by Swarm. Advisory for the mock viewer, because a mock's
 * numbers are synthetic — there is no measurement left to protect, and refusing
 * would only stop the rig's own tests from running on a working laptop.
 */
function idleCheck(machine: MachineInfo, mock: boolean): PreflightCheck {
  const load = os.loadavg()[0] ?? 0;
  const ceiling = machine.cores * 0.5;
  return {
    name: 'machine_idle',
    ok: load <= ceiling,
    fatal: !mock,
    value: load.toFixed(2),
    detail:
      load <= ceiling
        ? `load ${load.toFixed(2)} of ${machine.cores} cores`
        : mock
          ? `load is already ${load.toFixed(2)} of ${machine.cores} cores, which would ruin a real measurement; allowed here because the mock viewer is not one`
          : `load is already ${load.toFixed(2)} of ${machine.cores} cores; whatever else is running would end up in the measurement`,
  };
}

function portCheck(machine: MachineInfo, maxViewers: number, peerLimit: number): PreflightCheck {
  const first = machine.portRangeFirst;
  const last = machine.portRangeLast;
  if (first === undefined || last === undefined) {
    return {
      name: 'ephemeral_ports',
      ok: true,
      fatal: false,
      detail: 'could not read the ephemeral port range',
    };
  }
  const available = last - first + 1;
  const needed = maxViewers * peerLimit;
  // Advisory on purpose: whether this arithmetic actually predicts the ceiling
  // is exactly what the `port-ceiling` scenario exists to find out, so a run
  // designed to exceed it must not be refused here.
  return {
    name: 'ephemeral_ports',
    ok: needed <= available,
    fatal: false,
    value: `${needed} of ${available} (${first}-${last})`,
    detail:
      needed <= available
        ? `${available} ephemeral ports for ~${needed} outbound sockets`
        : `~${needed} outbound sockets against ${available} ephemeral ports: expect dials to start failing around ${Math.floor(available / peerLimit)} viewers. Raise net.inet.ip.portrange.first / ip_local_port_range, or treat this as the measurement.`,
  };
}

async function checkBinary(
  binary: string,
): Promise<{ check: PreflightCheck; sha256?: string | undefined; path?: string | undefined }> {
  if (binary === MOCK_BINARY) {
    return {
      check: {
        name: 'binary',
        ok: true,
        fatal: false,
        value: MOCK_BINARY,
        detail: 'built-in fake viewer: plumbing only, not a measurement of Swarm',
      },
    };
  }
  const resolved = path.resolve(binary);
  try {
    await access(resolved, constants.X_OK);
  } catch {
    return {
      check: {
        name: 'binary',
        ok: false,
        fatal: true,
        value: resolved,
        detail: 'not present or not executable on this machine',
      },
    };
  }
  const sha256 = await hashFile(resolved);
  return {
    check: {
      name: 'binary',
      ok: true,
      fatal: true,
      value: `${resolved} (${sha256.slice(0, 12)}…)`,
      // Recorded so a fleet cannot silently mix two builds across machines.
      detail: 'sha256 recorded in run.json; every agent must report the same one',
    },
    sha256,
    path: resolved,
  };
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function weeb3GitSha(binaryPath: string): Promise<string | undefined> {
  // The binary normally sits at <repo>/target/release/weeb-3-rs-hls.
  const guess = path.resolve(path.dirname(binaryPath), '..', '..');
  const stdout = await run('git', ['-C', guess, 'rev-parse', 'HEAD']);
  return stdout?.trim();
}

async function ephemeralPortRange(): Promise<{ first: number; last: number } | undefined> {
  if (process.platform === 'linux') {
    try {
      const raw = await readFile('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');
      const [first, last] = raw.trim().split(/\s+/).map(Number);
      return first !== undefined && last !== undefined && Number.isFinite(first) && Number.isFinite(last)
        ? { first, last }
        : undefined;
    } catch {
      return undefined;
    }
  }
  const stdout = await run('sysctl', [
    '-n',
    'net.inet.ip.portrange.first',
    'net.inet.ip.portrange.last',
  ]);
  if (stdout === undefined) {
    return undefined;
  }
  const [first, last] = stdout.trim().split('\n').map(Number);
  return first !== undefined && last !== undefined && Number.isFinite(first) && Number.isFinite(last)
    ? { first, last }
    : undefined;
}

/**
 * This process's soft descriptor limit, as a number.
 *
 * Exported because raising it is a separate job from reporting on it: a
 * participant's laptop is re-exec'd under a raised limit before the run starts,
 * and that decision needs the same reading preflight prints.
 */
export async function fileDescriptorLimit(): Promise<number | undefined> {
  const stdout = await run('/bin/sh', ['-c', 'ulimit -n']);
  if (stdout === undefined) {
    return undefined;
  }
  const text = stdout.trim();
  if (text === 'unlimited') {
    return Number.MAX_SAFE_INTEGER;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function run(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 5_000 }, (error, stdout) => {
      resolve(error !== null ? undefined : stdout);
    });
  });
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
