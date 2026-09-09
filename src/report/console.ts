/**
 * The live view.
 *
 * 200 viewers' worth of scrolling log is not information, so the run redraws
 * one block in place: how many viewers are up, what share of them is having a
 * bad time, what the fleet is pulling out of Swarm, and whether the guards
 * still hold. Anything more detailed is in the run directory.
 *
 * Below that, one row per machine. A fleet run fails at the machine level — a
 * box that ran out of CPU, a box whose NIC saturated, a box whose agent is
 * being held back by admission control — and none of that is visible in a
 * fleet-wide average. The numbers are the same ones the guards judge, so a run
 * that is about to be marked invalid looks wrong on screen first.
 *
 * Three things here are load-bearing rather than decorative:
 *
 * -   **Every line is clipped to the terminal width.** The block is redrawn by
 *     moving the cursor up as many rows as it printed, which is the same number
 *     as the *lines* it printed only if none of them wrapped. One over-wide
 *     machine row made the whole frame march down the screen, leaving a copy of
 *     its top line behind every second.
 * -   **The table is laid out to fit.** Columns have declared widths and the
 *     least informative ones are dropped on a narrow terminal, because a
 *     20-character hostname silently eating its neighbour's column is worse
 *     than not showing sockets.
 * -   **Logs go through the view.** A controller log written straight to the
 *     same stream lands in the middle of the block; `log()` erases the block
 *     first and lets the next frame redraw below it.
 */

import Table from 'cli-table3';
import pc from 'picocolors';
import type { AgentSnapshot, LiveSnapshot } from '../controller.js';

const ESC = '\u001b';
const cursorUp = (rows: number): string => `${ESC}[${rows}A`;
const CLEAR_BELOW = `${ESC}[0J`;
const RESET = `${ESC}[0m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const INDENT = '  ';
/** Narrower than this and the block would have to give up a column it needs. */
const MIN_WIDTH = 40;

export interface ConsoleViewOptions {
  /** Where the block is drawn. stderr, so stdout stays machine output. */
  out?: NodeJS.WriteStream;
  /** Overridden by the tests; otherwise "is this a terminal". */
  interactive?: boolean;
  /** Enables the progress bar. Absent for a segment- or ramp-bounded run. */
  durationS?: number | undefined;
}

export class ConsoleView {
  private readonly out: NodeJS.WriteStream;
  private readonly interactive: boolean;
  private readonly durationS: number | undefined;
  private rowsDrawn = 0;
  private widthDrawnAt = 0;
  private cursorHidden = false;
  private lastPlainAtMs = 0;

  constructor(options: ConsoleViewOptions = {}) {
    this.out = options.out ?? process.stderr;
    this.interactive = options.interactive ?? this.out.isTTY === true;
    this.durationS = options.durationS;
  }

  render(snapshot: LiveSnapshot): void {
    if (!this.interactive) {
      // Not a terminal: one line every 10 s, so a log file stays readable.
      const now = Date.now();
      if (now - this.lastPlainAtMs < 10_000) {
        return;
      }
      this.lastPlainAtMs = now;
      this.out.write(`${oneLine(snapshot)}\n`);
      return;
    }

    const width = this.width();
    // A resize reflows what is already on screen, so the row count we are
    // holding stops describing it. Start a fresh block rather than erase the
    // wrong rows.
    if (width !== this.widthDrawnAt) {
      this.rowsDrawn = 0;
    }
    if (!this.cursorHidden) {
      this.out.write(HIDE_CURSOR);
      this.cursorHidden = true;
      // A crash between here and `release()` would otherwise leave the shell
      // with no cursor.
      process.once('exit', () => this.release());
    }

    const lines = this.block(snapshot, width).map((line) => clip(line, width));
    this.erase();
    this.out.write(`${lines.join('\n')}\n`);
    this.rowsDrawn = lines.length;
    this.widthDrawnAt = width;
  }

  /**
   * A line that belongs in the scrollback rather than in the block.
   *
   * Written where the block currently is, which then redraws below it — so the
   * log survives and the block stays whole.
   */
  log(text: string): void {
    if (!this.interactive) {
      this.out.write(`${text}\n`);
      return;
    }
    this.erase();
    this.out.write(`${clip(text, this.width())}\n`);
  }

  /** Leave the last frame on screen, stop owning those rows, give the cursor back. */
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
    // A pty that has never been resized reports 0 columns rather than nothing
    // at all — `script` does — and taking that literally squeezes the block to
    // its floor on a terminal that is really 200 wide.
    const columns = this.out.columns;
    // One short of the real width: a line that exactly fills the terminal
    // leaves the cursor in a deferred-wrap state that some terminals resolve
    // as an extra row, which is the same off-by-one in a subtler form.
    return Math.max(MIN_WIDTH, (columns === undefined || columns <= 0 ? 100 : columns) - 1);
  }

  private block(snapshot: LiveSnapshot, width: number): string[] {
    return [
      '',
      INDENT + this.headline(snapshot, width - INDENT.length),
      '',
      ...indent(fleetTable(snapshot, width - INDENT.length)),
      '',
      ...indent(machineTable(snapshot.agents, width - INDENT.length)),
    ];
  }

  /**
   * The one-line summary above the tables. Drops from the right rather than
   * being cut mid-word: the fields are already in order of importance.
   */
  private headline(snapshot: LiveSnapshot, width: number): string {
    const clock =
      this.durationS === undefined
        ? mmss(snapshot.elapsedS)
        : `${mmss(snapshot.elapsedS)}/${mmss(this.durationS)}`;
    const parts = [
      `${pc.dim('elapsed')} ${pc.bold(clock)}`,
      ...(this.durationS === undefined ? [] : [bar(snapshot.elapsedS / this.durationS, 18)]),
      `${pc.dim('viewers')} ${pc.bold(`${snapshot.active}/${snapshot.target}`)}`,
      `${pc.dim('joined')} ${snapshot.joined}`,
      `${pc.dim('bootstrapping')} ${snapshot.bootstrapping}`,
    ];
    // Only while settling, and second from the left: during that phase it is
    // the number the operator is actually waiting on.
    if ((snapshot.held ?? 0) > 0) {
      parts.splice(2, 0, `${pc.dim('held')} ${pc.bold(String(snapshot.held))}`);
    }
    if (snapshot.exited > 0) {
      parts.push(`${pc.dim('exited')} ${snapshot.exited}`);
    }
    while (parts.length > 1 && visibleWidth(parts.join('  ')) > width) {
      parts.pop();
    }
    return parts.join('  ');
  }
}

// -------------------------------------------------------------- the tables

/**
 * A column, and what it is worth.
 *
 * `drop` is the rank at which a column stops earning its space on a narrow
 * terminal: the highest number goes first, and a column without one is never
 * given up, because a table missing it says nothing that could be acted on.
 * `flex` marks the free-text columns, which are sized to their content and
 * absorb whatever slack is left over or still missing.
 */
interface Column<K extends string> {
  key: K;
  head: string;
  width: number;
  drop?: number;
  flex?: { min: number; floor: number; max: number };
}

type Cells<K extends string> = Record<K, string>;

/**
 * Lay a table out to fit, and render it.
 *
 * Fitting is not cosmetic. The block is redrawn by moving the cursor up as many
 * rows as it printed, which is the same number as the *lines* it printed only
 * if none of them wrapped, so a row wider than the terminal breaks the redraw
 * for the rest of the run.
 */
function renderTable<K extends string>(
  declared: readonly Column<K>[],
  rows: readonly Cells<K>[],
  width: number,
  paint: (key: K, text: string, row: number) => string = (_key, text) => text,
): string[] {
  const columns = fitColumns(declared, rows, width);
  const table = new Table({
    head: columns.map((column) => column.head),
    colWidths: columns.map((column) => column.width),
    truncate: '…',
    wordWrap: false,
    // No rule between rows: with a dozen machines the separators outnumber the
    // data and the block doubles in height for nothing.
    chars: { mid: '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' },
    style: { head: [], border: [], 'padding-left': 1, 'padding-right': 1 },
  });
  rows.forEach((cells, index) => {
    table.push(columns.map((column) => paint(column.key, cells[column.key], index)));
  });
  return withHeaderRule(String(table).split('\n'));
}

/**
 * Size the flexible columns to their content, then give columns up — and
 * finally squeeze the flexible ones — until the table fits.
 */
function fitColumns<K extends string>(
  declared: readonly Column<K>[],
  rows: readonly Cells<K>[],
  width: number,
): Column<K>[] {
  const longest = (key: K): number =>
    rows.reduce((most, row) => Math.max(most, row[key].length), 0) + 2;
  let columns = declared.map((column) => ({
    ...column,
    width:
      column.flex === undefined
        ? column.width
        : Math.min(column.flex.max, Math.max(column.flex.min, longest(column.key))),
  }));

  // Borders: one down each side of every column, sharing the inner ones.
  const total = (): number =>
    columns.reduce((sum, column) => sum + column.width, 0) + columns.length + 1;

  while (total() > width) {
    const give = columns
      .filter((column) => column.drop !== undefined)
      .sort((a, b) => (b.drop as number) - (a.drop as number))[0];
    if (give === undefined) {
      break;
    }
    columns = columns.filter((column) => column.key !== give.key);
  }

  // Slack, or what is still missing, lands on the flexible columns, last one
  // first: a truncated reason still names the guard that fired, where a
  // truncated hostname stops identifying the machine. Two passes, because
  // squeezing the last one may not be enough on its own.
  const flex = (column: (typeof columns)[number]): void => {
    if (column.flex !== undefined) {
      column.width = Math.min(
        column.flex.max,
        Math.max(column.flex.floor, column.width + (width - total())),
      );
    }
  };
  const flexible = columns.filter((column) => column.flex !== undefined).reverse();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const column of flexible) {
      flex(column);
    }
  }
  return columns;
}

/**
 * Put the rule back under the header row.
 *
 * cli-table3 draws the header separator with the same characters as the
 * separators between rows, and switching those off to stop a dozen machines
 * costing two dozen lines takes the header rule with them. Deriving it from the
 * top border keeps the corners consistent whatever the column widths are.
 */
function withHeaderRule(lines: string[]): string[] {
  const top = lines[0];
  const header = lines[1];
  if (top === undefined || header === undefined || lines.length < 3) {
    return lines;
  }
  const rule = top.replaceAll('┌', '├').replaceAll('┬', '┼').replaceAll('┐', '┤');
  return [top, header, rule, ...lines.slice(2)];
}

// ---------------------------------------------------------------- the fleet

type FleetColumn =
  | 'degraded'
  | 'stall'
  | 'realtime'
  | 'media'
  | 'segments'
  | 'retrieved'
  | 'guards';

/**
 * What the run is measuring, in one row.
 *
 * `degraded` first because it is the headline KPI and `realtime p95` beside it
 * because it is the leading indicator — it moves before anything stalls — so
 * those two and the guard verdict are the ones that never drop.
 */
const FLEET_COLUMNS: Column<FleetColumn>[] = [
  { key: 'degraded', head: 'degraded', width: 10 },
  { key: 'stall', head: 'stall p95', width: 11, drop: 2 },
  { key: 'realtime', head: 'realtime p95', width: 14 },
  { key: 'media', head: 'media', width: 12, drop: 1 },
  { key: 'segments', head: 'segments', width: 10, drop: 3 },
  { key: 'retrieved', head: 'retrieved', width: 11, drop: 4 },
  { key: 'guards', head: 'guards', width: 10 },
];

export function fleetTable(snapshot: LiveSnapshot, width: number): string[] {
  const cells: Cells<FleetColumn> = {
    degraded: percent(snapshot.degradedFraction),
    stall: percent(snapshot.stallRatioP95),
    realtime: number(snapshot.realtimeFactorP95, 2),
    media: `${snapshot.windowMbps.toFixed(1)} Mbps`,
    segments: String(snapshot.segments),
    retrieved: megabytes(snapshot.bytes),
    guards: snapshot.guardsOk ? 'ok' : 'BREACHED',
  };
  return renderTable(FLEET_COLUMNS, [cells], width, (key, text) => {
    if (key === 'degraded') {
      return warnAbove(text, snapshot.degradedFraction, 0.01);
    }
    if (key === 'realtime') {
      return warnAbove(text, snapshot.realtimeFactorP95, 1);
    }
    if (key === 'guards') {
      return snapshot.guardsOk ? pc.green(text) : pc.red(text);
    }
    return text;
  });
}

// ------------------------------------------------------------- the machines

type MachineColumn =
  | 'host'
  | 'viewers'
  | 'bootstrapping'
  | 'held'
  | 'cpu'
  | 'load'
  | 'mem'
  | 'net'
  | 'sockets'
  | 'note';

/**
 * One machine's cells, plain text.
 *
 * `viewers` and `bootstrapping` are separate columns rather than the old
 * `25/25+5`, which read as an addition and was not one: the bootstrapping count
 * is a *subset* of the active viewers — those that have not yet reported a join
 * — so `25/25+25` meant "all 25 are up and none has joined yet", not "50
 * viewers".
 */
export function machineCells(agent: AgentSnapshot): Cells<MachineColumn> {
  return {
    host: agent.name,
    viewers: `${agent.active}/${agent.target}`,
    bootstrapping: String(agent.bootstrapping),
    held: (agent.held ?? 0) === 0 ? '-' : String(agent.held),
    cpu: percent(agent.cpuUtilisation),
    // Load against the machine's core count, because 4.2 means nothing until
    // you know whether the box has 4 cores or 64.
    load:
      agent.loadAvg1 === undefined
        ? '-'
        : agent.cores === undefined
          ? agent.loadAvg1.toFixed(2)
          : `${agent.loadAvg1.toFixed(1)}/${agent.cores}`,
    mem: percent(agent.memUsedFraction),
    net: agent.rxMbps === undefined ? '-' : `${agent.rxMbps.toFixed(1)}/${number(agent.txMbps, 1)}`,
    sockets: agent.establishedSockets === undefined ? '-' : String(agent.establishedSockets),
    note:
      agent.breachedGuard !== undefined
        ? `BREACHED ${agent.breachedGuard}`
        : (agent.admissionReason ?? ''),
  };
}

const MACHINE_COLUMNS: Column<MachineColumn>[] = [
  { key: 'host', head: 'host', width: 20, flex: { min: 20, floor: 10, max: 28 } },
  { key: 'viewers', head: 'viewers', width: 9 },
  { key: 'bootstrapping', head: 'booting', width: 9, drop: 3 },
  // First to go when the terminal is narrow: it is only ever non-zero during
  // the settle phase, and the headline carries the same number.
  { key: 'held', head: 'held', width: 7, drop: 6 },
  { key: 'cpu', head: 'cpu', width: 8 },
  { key: 'load', head: 'load', width: 9, drop: 4 },
  { key: 'mem', head: 'mem', width: 8, drop: 2 },
  { key: 'net', head: 'rx/tx Mbps', width: 14, drop: 1 },
  { key: 'sockets', head: 'sockets', width: 9, drop: 5 },
  { key: 'note', head: 'note', width: 24, flex: { min: 12, floor: 6, max: 40 } },
];

export function machineTable(agents: readonly AgentSnapshot[], width: number): string[] {
  const rows = agents.map((agent) => machineCells(agent));
  return renderTable(MACHINE_COLUMNS, rows, width, (key, text, index) => {
    if (key !== 'note' || text === '') {
      return text;
    }
    return agents[index]?.breachedGuard !== undefined ? pc.red(text) : pc.dim(text);
  });
}

// ------------------------------------------------------------ non-terminal

function oneLine(snapshot: LiveSnapshot): string {
  return [
    `t=${snapshot.elapsedS.toFixed(0)}s`,
    `viewers ${snapshot.active}/${snapshot.target}`,
    `joined ${snapshot.joined}`,
    `degraded ${percent(snapshot.degradedFraction)}`,
    `rtf.p95 ${number(snapshot.realtimeFactorP95, 2)}`,
    `${snapshot.windowMbps.toFixed(1)} Mbps`,
    `cpu.max ${percent(worstCpu(snapshot.agents))}`,
    `wire ${number(totalRxMbps(snapshot.agents), 1)} Mbps`,
    `guards ${snapshot.guardsOk ? 'ok' : 'BREACHED'}`,
  ].join('  ');
}

/** The busiest machine, since a fleet is limited by its worst box, not its mean. */
function worstCpu(agents: readonly AgentSnapshot[]): number | undefined {
  const values = agents
    .map((agent) => agent.cpuUtilisation)
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

/** Wire bytes across the fleet, for comparison with the media bytes above it. */
function totalRxMbps(agents: readonly AgentSnapshot[]): number | undefined {
  const values = agents
    .map((agent) => agent.rxMbps)
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : values.reduce((total, value) => total + value, 0);
}

// ------------------------------------------------------------------ pieces

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => INDENT + line);
}

function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return pc.cyan('█'.repeat(filled)) + pc.dim('░'.repeat(width - filled));
}

function mmss(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? '-' : `${(value * 100).toFixed(1)}%`;
}

function number(value: number | undefined, digits: number): string {
  return value === undefined ? '-' : value.toFixed(digits);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function warnAbove(text: string, value: number | undefined, threshold: number): string {
  if (value === undefined) {
    return text;
  }
  return value > threshold ? pc.yellow(text) : text;
}

/** How wide a line prints, which is not its length once it carries colour. */
export function visibleWidth(line: string): number {
  return line.replace(/\u001b\[[0-9;]*m/g, '').length;
}

/** Cut a line to the terminal width without counting the colour codes in it. */
export function clip(line: string, width: number): string {
  let visible = 0;
  let at = 0;
  while (at < line.length) {
    const escape = /^\u001b\[[0-9;]*m/.exec(line.slice(at));
    if (escape !== null) {
      at += escape[0].length;
      continue;
    }
    if (visible === width) {
      // Keep a reset, so a cut mid-colour does not bleed down the page.
      return `${line.slice(0, at)}${RESET}`;
    }
    visible += 1;
    at += 1;
  }
  return line;
}
