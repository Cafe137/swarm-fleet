/**
 * The screen a participant watches during a load test.
 *
 * Different audience from `report/console.ts`, and therefore a different
 * screen. That one is for someone auditing a measurement: it shows the guards,
 * the per-machine headroom, the numbers that decide whether a run may be
 * published. This one is for whoever is running a node on their own machine and has
 * never heard of a realtime factor. It answers four questions — am I running,
 * how much am I pulling, is anything wrong, and what do the keys do — and keeps
 * the rig's own diagnostics to one dim line at the bottom.
 *
 * The redraw discipline is inherited wholesale, because it is load-bearing: the
 * block is erased by moving the cursor up as many rows as it printed, so every
 * line must be clipped to the terminal width or one wrapped row marches the
 * frame down the screen for the rest of the session.
 */

import pc from 'picocolors';
import { clip, visibleWidth } from '../report/console.js';
import type { FleetTotals, LeaderboardRow } from './protocol.js';

const ESC = '\u001b';
const cursorUp = (rows: number): string => `${ESC}[${rows}A`;
const CLEAR_BELOW = `${ESC}[0J`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const INDENT = '  ';
const MIN_WIDTH = 40;
/** Rows of the leaderboard worth showing on a participant's screen. */
const LEADERBOARD_ROWS = 6;

export interface SessionState {
  /** The anonymous name this participant appears as. */
  name: string;
  elapsedS: number;
  /** Viewers up, and viewers asked for. */
  viewers: number;
  target: number;
  bootstrapping: number;
  step: number;
  mediaMbps: number;
  segments: number;
  bytes: number;
  stalls: number;
  degradedFraction?: number | undefined;
  peersHeld?: number | undefined;
  cpuUtilisation?: number | undefined;
  memUsedFraction?: number | undefined;
  rxMbps?: number | undefined;
  txMbps?: number | undefined;
  /** What the server last said. Absent until the first report goes through. */
  rank?: number | undefined;
  totals?: FleetTotals | undefined;
  leaderboard?: readonly LeaderboardRow[] | undefined;
  /** Set while reports are failing, so a lost server is visible immediately. */
  offlineSinceMs?: number | undefined;
  /** Standing warnings: a router likely to give up, a machine out of memory. */
  warnings: readonly string[];
  /** Set while the session is closing down, so the keys stop being advertised. */
  stopping: boolean;
}

export interface SessionViewOptions {
  out?: NodeJS.WriteStream;
  interactive?: boolean;
}

export class SessionView {
  private readonly out: NodeJS.WriteStream;
  private readonly interactive: boolean;
  private rowsDrawn = 0;
  private widthDrawnAt = 0;
  private cursorHidden = false;
  private lastPlainAtMs = 0;

  constructor(options: SessionViewOptions = {}) {
    this.out = options.out ?? process.stderr;
    this.interactive = options.interactive ?? this.out.isTTY === true;
  }

  render(state: SessionState): void {
    if (!this.interactive) {
      // Piped to a file: one line every 15 s, matching the report interval, so
      // the log reads as a record of what was sent rather than as an animation.
      const now = Date.now();
      if (now - this.lastPlainAtMs < 15_000) {
        return;
      }
      this.lastPlainAtMs = now;
      this.out.write(
        `${state.name}: ${state.viewers} nodes, ${state.mediaMbps.toFixed(1)} Mbps, ` +
          `${state.segments} segments, ${state.stalls} stalls\n`,
      );
      return;
    }

    const width = this.width();
    if (width !== this.widthDrawnAt) {
      this.rowsDrawn = 0;
    }
    if (!this.cursorHidden) {
      this.out.write(HIDE_CURSOR);
      this.cursorHidden = true;
      process.once('exit', () => this.release());
    }
    // `sessionLines` clips, because a caller that forgot to would break every
    // frame after the first wrapped row rather than printing one long line.
    const lines = sessionLines(state, width);
    this.erase();
    this.out.write(`${lines.join('\n')}\n`);
    this.rowsDrawn = lines.length;
    this.widthDrawnAt = width;
  }

  log(text: string): void {
    if (!this.interactive) {
      this.out.write(`${text}\n`);
      return;
    }
    this.erase();
    this.out.write(`${clip(text, this.width())}\n`);
  }

  release(): void {
    this.rowsDrawn = 0;
    if (this.cursorHidden) {
      this.out.write(SHOW_CURSOR);
      this.cursorHidden = false;
    }
  }

  private erase(): void {
    if (this.rowsDrawn > 0) {
      this.out.write(`${cursorUp(this.rowsDrawn)}${CLEAR_BELOW}`);
      this.rowsDrawn = 0;
    }
  }

  private width(): number {
    const columns = this.out.columns;
    return Math.max(MIN_WIDTH, (columns === undefined || columns <= 0 ? 100 : columns) - 1);
  }
}

/**
 * The block, as plain strings.
 *
 * Separate from the view so it can be tested without a terminal, and so the
 * order of the lines is one readable thing rather than a method that both
 * computes and paints.
 */
export function sessionLines(state: SessionState, width: number): string[] {
  const inner = width - INDENT.length;
  const lines: string[] = [
    '',
    INDENT +
      `${pc.dim('Swarm load test')}  ${pc.bold(state.name)}  ${pc.dim(`up ${mmss(state.elapsedS)}`)}`,
    '',
    INDENT + field('nodes', nodesText(state)),
    INDENT + field('pulling', pullingText(state)),
    INDENT + field('health', healthText(state)),
  ];

  const totals = state.totals;
  if (totals !== undefined) {
    const place =
      state.rank === undefined ? '' : `  ${pc.dim('you are')} ${pc.bold(`#${state.rank}`)}`;
    lines.push(
      INDENT +
        field(
          'everyone',
          `${pc.bold(String(totals.viewers))} nodes from ${totals.online} of ` +
            `${totals.participants} people  ${pc.bold(`${totals.mediaMbps.toFixed(1)} Mbps`)}` +
            place,
        ),
    );
  }

  const board = state.leaderboard ?? [];
  if (board.length > 0) {
    lines.push('', ...leaderboardLines(board, state.name, inner).map((line) => INDENT + line));
  }

  for (const warning of state.warnings) {
    lines.push('', INDENT + pc.yellow(`! ${warning}`));
  }

  lines.push('', INDENT + pc.dim(machineText(state)));
  lines.push(INDENT + (state.stopping ? pc.dim('stopping, one moment') : keysText(state.step)));
  return lines.map((line) => clip(line, width));
}

function nodesText(state: SessionState): string {
  const parts = [pc.bold(`${state.viewers}`), pc.dim(`of ${state.target} asked for`)];
  if (state.bootstrapping > 0) {
    parts.push(pc.dim(`- ${state.bootstrapping} still joining`));
  }
  if (state.peersHeld !== undefined && state.peersHeld > 0) {
    parts.push(pc.dim(`- ${state.peersHeld.toLocaleString('en-US')} peer connections`));
  }
  return parts.join(' ');
}

function pullingText(state: SessionState): string {
  return (
    `${pc.bold(`${state.mediaMbps.toFixed(1)} Mbps`)} ` +
    pc.dim(
      `- ${state.segments.toLocaleString('en-US')} segments - ${gigabytes(state.bytes)} total`,
    )
  );
}

/**
 * One honest word about whether this machine is coping.
 *
 * `degradedFraction` is the rig's headline KPI — the share of viewers losing
 * more than 1% of their media time to stalling — and it is exactly the right
 * thing to show here, as long as it is shown in English. A participant does not
 * need to know the threshold; they need to know whether to push further.
 */
function healthText(state: SessionState): string {
  const degraded = state.degradedFraction ?? 0;
  if (state.viewers === 0) {
    return pc.dim('nothing running');
  }
  if (degraded >= 0.25) {
    return `${pc.red('struggling')} ${pc.dim(`- ${percent(degraded)} of your nodes are stalling`)}`;
  }
  if (degraded > 0.05 || state.stalls > 0) {
    return `${pc.yellow('some stalling')} ${pc.dim(
      `- ${state.stalls} stalls, ${percent(degraded)} of nodes affected`,
    )}`;
  }
  return `${pc.green('all good')} ${pc.dim('- no stalls')}`;
}

function machineText(state: SessionState): string {
  const parts = [
    `cpu ${percent(state.cpuUtilisation)}`,
    // The share of this machine's memory the nodes themselves hold, not the
    // machine's free memory: macOS reports almost none free at the best of
    // times, and a permanent "out of memory" warning would teach people to
    // ignore the line that matters.
    `memory held by nodes ${percent(state.memUsedFraction)}`,
    `network down ${mbps(state.rxMbps)} up ${mbps(state.txMbps)}`,
  ];
  if (state.offlineSinceMs !== undefined) {
    parts.push(
      pc.yellow(
        `not reaching the server for ${Math.round((Date.now() - state.offlineSinceMs) / 1000)}s`,
      ),
    );
  }
  return parts.join('   ');
}

function keysText(step: number): string {
  return [
    `${pc.bold('right arrow')} ${pc.dim(`add ${step}`)}`,
    `${pc.bold('left arrow')} ${pc.dim(`remove ${step}`)}`,
    `${pc.bold('q')} ${pc.dim('quit')}`,
  ].join('    ');
}

function leaderboardLines(
  board: readonly LeaderboardRow[],
  me: string,
  width: number,
): string[] {
  const shown = board.slice(0, LEADERBOARD_ROWS);
  // The participant's own row is always on screen, even at position 40: seeing
  // where you are is the entire reason a leaderboard is here.
  if (!shown.some((row) => row.name === me)) {
    const mine = board.find((row) => row.name === me);
    if (mine !== undefined) {
      shown[Math.max(0, shown.length - 1)] = mine;
    }
  }
  const nameWidth = Math.min(24, Math.max(8, ...shown.map((row) => visibleWidth(row.name))));
  return shown.map((row) => {
    const rank = `${board.indexOf(row) + 1}`.padStart(2);
    const name = row.name.padEnd(nameWidth).slice(0, nameWidth);
    const line =
      `${pc.dim(rank)}  ${name}  ${`${row.viewers}`.padStart(4)} nodes  ` +
      `${row.mediaMbps.toFixed(1).padStart(6)} Mbps`;
    const marked = row.online ? line : pc.dim(`${line}  (offline)`);
    return clip(row.name === me ? pc.bold(marked) : marked, width);
  });
}

function field(label: string, value: string): string {
  return `${pc.dim(label.padEnd(9))}${value}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? '-' : `${Math.round(value * 100)}%`;
}

function mbps(value: number | undefined): string {
  return value === undefined ? '-' : `${value.toFixed(1)}`;
}

function gigabytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function mmss(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${`${total % 60}`.padStart(2, '0')}`;
}
