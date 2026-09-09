/**
 * One viewer process: launch it, read its two output streams, kill it cleanly.
 *
 * Every viewer is its own process, and that is not an implementation choice.
 * The decoded-chunk cache is a `thread_local!` and chunks are content-addressed,
 * so viewers sharing a process would serve each other out of local memory and
 * the rig would under-report retrieval traffic by exactly the amount it exists
 * to measure. See the cache note in CLAUDE.md.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { StreamRef, ViewerSpec } from '../transport/protocol.js';

/** A stdout line longer than this is a bug, not a datum. Dropped and counted. */
const MAX_LINE_BYTES = 1 << 20;
/** Stderr lines kept in memory so a crash can be explained without the file. */
const STDERR_TAIL_LINES = 40;

export const MOCK_BINARY = 'mock';

export interface ViewerLaunch {
  viewerId: string;
  spec: ViewerSpec;
  stream: StreamRef;
  /** `<dir>/<viewerId>.ndjson` and `.log` are written here. */
  outDir: string;
}

export interface ViewerHandle {
  viewerId: string;
  pid: number;
  stream: StreamRef;
  peerLimit: number;
  live: boolean;
  argv: readonly string[];
  /**
   * Open the viewer's `--hold` barrier. A no-op for a viewer not holding.
   *
   * The go-ahead is a line on stdin rather than a signal: SIGUSR1 is reserved
   * by Node, so the mock viewer could not have honoured the same mechanism, and
   * a barrier the fake viewer cannot implement is a barrier the runner's own
   * tests cannot cover.
   */
  release(): void;
  /** SIGTERM the process group, then SIGKILL it after `graceMs`. */
  stop(graceMs: number): void;
  /** Whether the exit we are about to see was asked for. */
  readonly requested: boolean;
  readonly stderrTail: readonly string[];
}

export interface ViewerHooks {
  onLine(viewerId: string, line: string): void;
  onOversizeLine(viewerId: string, bytes: number): void;
  onExit(viewerId: string, code: number | null, signal: string | null, requested: boolean): void;
  onSpawnError(viewerId: string, message: string): void;
}

/**
 * Argument vector for the native viewer.
 *
 * `--metrics json` puts machine output on stdout and leaves the human `tracing`
 * output on stderr, so both consumers coexist and the runner never parses text.
 */
export function viewerArgs(spec: ViewerSpec, stream: StreamRef): string[] {
  const args = ['watch', stream.owner, stream.topic, '--metrics', 'json'];
  if (spec.live) {
    args.push('--live');
  }
  if (spec.segments !== undefined) {
    args.push('--segments', String(spec.segments));
  }
  if (spec.durationS !== undefined) {
    args.push('--duration', String(spec.durationS));
  }
  if (spec.peerLimit !== undefined) {
    args.push('--peers', String(spec.peerLimit));
  }
  if (spec.dialRate !== undefined) {
    args.push('--dial-rate', String(spec.dialRate));
  }
  if (spec.peerUp !== undefined) {
    args.push('--peer-up', String(spec.peerUp));
  }
  if (spec.hold) {
    args.push('--hold');
  }
  // Passed either way, so the argv in the run directory says which it was
  // rather than leaving it to whatever the binary defaults to that week.
  args.push(spec.verifyChunks ? '--verify' : '--unsafe');
  args.push(...spec.extraArgs);
  if (spec.network === 'testnet') {
    args.push('testnet');
  }
  return args;
}

/**
 * The built-in fake viewer, addressed as `--binary mock`.
 *
 * Runs under whichever loader this process is using, so the mock works the same
 * from `tsx src/cli.ts` in development and from `dist/cli.js` in a fleet.
 */
export function mockCommand(): { command: string; prefix: string[] } {
  const here = fileURLToPath(import.meta.url);
  const typescript = here.endsWith('.ts');
  const entry = fileURLToPath(
    new URL(typescript ? '../mock/standalone.ts' : '../mock/standalone.js', import.meta.url),
  );
  return {
    command: process.execPath,
    prefix: typescript ? ['--import', 'tsx', entry] : [entry],
  };
}

export function launchViewer(launch: ViewerLaunch, hooks: ViewerHooks): ViewerHandle {
  const { viewerId, spec, stream, outDir } = launch;
  const args = viewerArgs(spec, stream);

  let command = spec.binary;
  let argv = args;
  if (spec.binary === MOCK_BINARY) {
    const mock = mockCommand();
    command = mock.command;
    argv = [...mock.prefix, ...args];
  }

  const child = spawn(command, argv, {
    // Its own process group, so `stop` can take down anything the viewer
    // spawned and a killed controller cannot leave 200 mainnet connections
    // per viewer behind.
    detached: true,
    // stdin is the release channel, and only a holding viewer reads it. Left
    // as a pipe for every viewer it would be an idle fd per process and an
    // EPIPE to explain; left as `ignore` for a holding one, the viewer sees
    // stdin closed and releases itself immediately.
    stdio: [spec.hold ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...spec.env },
  });

  const events = createWriteStream(`${outDir}/${viewerId}.ndjson`, { flags: 'a' });
  const log = createWriteStream(`${outDir}/${viewerId}.log`, { flags: 'a' });
  const stderrTail: string[] = [];
  let requested = false;
  let released = !spec.hold;
  let killTimer: NodeJS.Timeout | undefined;

  readLines(child, 'stdout', (line) => {
    events.write(`${line}\n`);
    hooks.onLine(viewerId, line);
  }, (bytes) => hooks.onOversizeLine(viewerId, bytes));

  readLines(child, 'stderr', (line) => {
    log.write(`${line}\n`);
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LINES) {
      stderrTail.shift();
    }
  }, () => undefined);

  child.on('error', (error) => {
    hooks.onSpawnError(viewerId, error.message);
  });

  child.on('exit', (code, signal) => {
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
    closeStream(events);
    closeStream(log);
    hooks.onExit(viewerId, code, signal, requested);
  });

  return {
    viewerId,
    pid: child.pid ?? -1,
    stream,
    peerLimit: spec.peerLimit ?? 0,
    live: spec.live,
    argv: [command, ...argv],
    get requested() {
      return requested;
    },
    get stderrTail() {
      return stderrTail;
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      const stdin = child.stdin;
      if (stdin === null) {
        return;
      }
      // Ending stdin as well as writing to it: the viewer needs one line, and
      // a still-open pipe would keep an fd per viewer for the rest of the run.
      stdin.on('error', () => undefined);
      stdin.end('go\n');
    },
    stop(graceMs: number) {
      if (requested) {
        return;
      }
      requested = true;
      // SIGTERM so the viewer can finish and emit its summary. Without a
      // handler on the Rust side this is still a clean kill, but the run loses
      // that viewer's authoritative numbers — see FLEET-PLAN.md §9.
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs);
      killTimer.unref();
    },
  };
}

/** Signal the whole group, falling back to the process if the group is gone. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone. Nothing to do, and nothing worth reporting.
    }
  }
}

function readLines(
  child: ChildProcess,
  which: 'stdout' | 'stderr',
  onLine: (line: string) => void,
  onOversize: (bytes: number) => void,
): void {
  const stream = which === 'stdout' ? child.stdout : child.stderr;
  if (stream === null) {
    return;
  }
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newline = pending.indexOf('\n');
    }
    if (pending.length > MAX_LINE_BYTES) {
      onOversize(pending.length);
      pending = '';
    }
  });
  stream.on('end', () => {
    if (pending.trim().length > 0) {
      onLine(pending);
      pending = '';
    }
  });
}

function closeStream(stream: WriteStream): void {
  stream.end();
}
