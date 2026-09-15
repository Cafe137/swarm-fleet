/**
 * Raising this machine's descriptor limit before it is too late to matter.
 *
 * One viewer holds 200 peer connections, so it needs a little over 200
 * descriptors of its own. A viewer inherits its soft limit from whatever
 * started it, and the defaults are hostile: a stock Ubuntu ssh session gives
 * 1024 — four viewers — and a macOS terminal has historically given 256, which
 * is *one*. The failure does not look like a limit. It looks like dials timing
 * out, peers never arriving, and Swarm being slow.
 *
 * The remote path already solved this: `deploy/deploy.ts` wraps the agent
 * command in `sh -c 'ulimit -n "$(ulimit -Hn)"; ...'`, which needs no privilege
 * and no system configuration. This is the same trick for a run that starts on
 * the machine a human is sitting at, and it works the only way it can from
 * inside Node — Node exposes no `setrlimit`, so the process re-executes itself
 * under a shell that raises the limit first.
 *
 * Windows has no equivalent limit and needs none of this.
 */

import { spawn } from 'node:child_process';
import { fileDescriptorLimit } from './agent/preflight.js';

/** Set on the re-executed child, so it cannot re-exec itself for ever. */
export const RAISED_MARKER = 'SWARM_FLEET_LIMITS_RAISED';

/** Descriptors a viewer needs beyond its peers, and the parent's own slack. */
const PER_VIEWER_SLACK = 32;
const PROCESS_RESERVE = 256;

export function descriptorsNeeded(viewers: number, peersPerViewer: number): number {
  return viewers * (peersPerViewer + PER_VIEWER_SLACK) + PROCESS_RESERVE;
}

/**
 * The shell command that re-runs this process with as high a limit as it can
 * get.
 *
 * A ladder rather than one value, because the hard limit is spelled differently
 * everywhere: Linux reports a number, macOS reports `unlimited` and then
 * refuses anything above `kern.maxfilesperproc` at open time, and a hardened
 * box may refuse the lot. Each rung is tried only if the one before it failed,
 * and the last resort is to carry on with whatever we already had — a run that
 * might hit the limit is better than no run at all, and preflight reports the
 * limit either way.
 */
export function raiseCommand(argv: readonly string[]): string {
  const quoted = argv.map(shellQuote).join(' ');
  return (
    'ulimit -n "$(ulimit -Hn)" 2>/dev/null || ' +
    'ulimit -n 65536 2>/dev/null || ' +
    'ulimit -n 10240 2>/dev/null || ' +
    'ulimit -n 4096 2>/dev/null || true; ' +
    `exec ${quoted}`
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface LimitDecision {
  /** What the run needs, and what it has. */
  needed: number;
  current: number | undefined;
  /** Whether re-executing could plausibly help. */
  raise: boolean;
  reason: string;
}

export function decideRaise(
  needed: number,
  current: number | undefined,
  platform: NodeJS.Platform = process.platform,
  alreadyRaised: boolean = process.env[RAISED_MARKER] === '1',
): LimitDecision {
  if (platform === 'win32') {
    return { needed, current, raise: false, reason: 'Windows has no descriptor limit to raise' };
  }
  if (alreadyRaised) {
    return { needed, current, raise: false, reason: 'already re-executed once' };
  }
  if (current === undefined) {
    return { needed, current, raise: false, reason: 'could not read the current limit' };
  }
  if (current >= needed) {
    return { needed, current, raise: false, reason: `ulimit -n ${current} is already enough` };
  }
  return {
    needed,
    current,
    raise: true,
    reason: `ulimit -n ${current}, and ${needed} is needed`,
  };
}

/**
 * Make sure this process can open `needed` descriptors, re-executing if not.
 *
 * Returns when nothing had to be done. When it does re-execute, it does not
 * return at all: the child inherits the terminal, and this process waits and
 * exits with the child's status, so the keyboard, the redrawn dashboard and
 * Ctrl-C all behave as though nothing had happened.
 */
export async function ensureDescriptorLimit(
  needed: number,
  log: (message: string) => void = () => undefined,
): Promise<LimitDecision> {
  const decision = decideRaise(needed, await fileDescriptorLimit());
  if (!decision.raise) {
    return decision;
  }

  log(`raising the open-file limit: ${decision.reason}`);
  const argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  const child = spawn('/bin/sh', ['-c', raiseCommand(argv)], {
    stdio: 'inherit',
    env: { ...process.env, [RAISED_MARKER]: '1' },
  });

  await new Promise<void>((resolve) => {
    child.on('error', (error) => {
      // The shell itself could not be started. Carry on in this process rather
      // than failing: the limit may still be enough for a small run.
      log(`could not re-execute under a raised limit (${error.message}); carrying on`);
      resolve();
    });
    child.on('exit', (code, signal) => {
      process.exit(signal !== null ? 128 + signalNumber(signal) : (code ?? 0));
    });
  });
  return decision;
}

function signalNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGKILL':
      return 9;
    default:
      return 1;
  }
}
