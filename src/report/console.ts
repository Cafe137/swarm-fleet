/**
 * The live view.
 *
 * 200 viewers' worth of scrolling log is not information, so the run redraws
 * one block: how many viewers are up, what share of them is having a bad time,
 * what the fleet is pulling out of Swarm, and whether the guards still hold.
 * Anything more detailed is in the run directory.
 *
 * Below that, one line per machine. A fleet run fails at the machine level — a
 * box that ran out of CPU, a box whose NIC saturated, a box whose agent is
 * being held back by admission control — and none of that is visible in a
 * fleet-wide average. The numbers are the same ones the guards judge, so a run
 * that is about to be marked invalid looks wrong on screen first.
 */

import type { AgentSnapshot, LiveSnapshot } from '../controller.js';

const ESC = '\u001b';
const cursorUp = (lines: number): string => `${ESC}[${lines}A`;
const CLEAR_BELOW = `${ESC}[0J`;

export class ConsoleView {
  private linesDrawn = 0;
  private lastPlainAtMs = 0;

  constructor(
    private readonly out: NodeJS.WriteStream = process.stderr,
    private readonly interactive: boolean = process.stderr.isTTY === true,
  ) {}

  render(snapshot: LiveSnapshot): void {
    if (!this.interactive) {
      // Not a terminal: one line every 10 s, so a log file stays readable.
      const now = Date.now();
      if (now - this.lastPlainAtMs < 10_000) {
        return;
      }
      this.lastPlainAtMs = now;
      this.out.write(`${this.oneLine(snapshot)}\n`);
      return;
    }

    const lines = this.block(snapshot);
    if (this.linesDrawn > 0) {
      this.out.write(`${cursorUp(this.linesDrawn)}${CLEAR_BELOW}`);
    }
    this.out.write(`${lines.join('\n')}\n`);
    this.linesDrawn = lines.length;
  }

  /** Leave the last frame on screen and stop owning those lines. */
  release(): void {
    this.linesDrawn = 0;
  }

  private oneLine(snapshot: LiveSnapshot): string {
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

  private block(snapshot: LiveSnapshot): string[] {
    const lines: string[] = [];
    lines.push(
      `  elapsed ${pad(`${snapshot.elapsedS.toFixed(0)}s`, 8)}` +
        `viewers ${pad(`${snapshot.active}/${snapshot.target}`, 12)}` +
        `bootstrapping ${pad(String(snapshot.bootstrapping), 6)}` +
        `joined ${snapshot.joined}`,
    );
    lines.push(
      `  degraded ${pad(percent(snapshot.degradedFraction), 8)}` +
        `stall p95 ${pad(percent(snapshot.stallRatioP95), 10)}` +
        `realtime p95 ${pad(number(snapshot.realtimeFactorP95, 2), 8)}` +
        `${snapshot.windowMbps.toFixed(1)} Mbps media`,
    );
    lines.push(
      `  segments ${pad(String(snapshot.segments), 8)}` +
        `${mib(snapshot.bytes)} retrieved`.padEnd(22) +
        `guards ${snapshot.guardsOk ? 'ok' : 'BREACHED - run is invalid'}`,
    );
    lines.push('');
    lines.push(`  ${HEADER}`);
    for (const agent of snapshot.agents) {
      lines.push(`  ${agentLine(agent)}`);
    }
    return lines;
  }
}

const HEADER =
  pad('host', 18) +
  pad('viewers', 11) +
  pad('cpu', 7) +
  pad('load', 9) +
  pad('mem', 7) +
  pad('rx/tx Mbps', 16) +
  pad('sockets', 9) +
  'note';

/** One machine. Exported so the layout can be asserted on without a terminal. */
export function agentLine(agent: AgentSnapshot): string {
  const viewers =
    agent.bootstrapping > 0
      ? `${agent.active}/${agent.target}+${agent.bootstrapping}`
      : `${agent.active}/${agent.target}`;
  // Load against the machine's core count, because 4.2 means nothing until you
  // know whether the box has 4 cores or 64.
  const load =
    agent.loadAvg1 === undefined
      ? '-'
      : agent.cores === undefined
        ? agent.loadAvg1.toFixed(2)
        : `${agent.loadAvg1.toFixed(1)}/${agent.cores}`;
  const net =
    agent.rxMbps === undefined ? '-' : `${agent.rxMbps.toFixed(1)}/${number(agent.txMbps, 1)}`;
  const note =
    agent.breachedGuard !== undefined
      ? `BREACHED ${agent.breachedGuard}`
      : (agent.admissionReason ?? '');
  return (
    pad(agent.name, 18) +
    pad(viewers, 11) +
    pad(percent(agent.cpuUtilisation), 7) +
    pad(load, 9) +
    pad(percent(agent.memUsedFraction), 7) +
    pad(net, 16) +
    pad(agent.establishedSockets === undefined ? '-' : String(agent.establishedSockets), 9) +
    note
  ).trimEnd();
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

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

function percent(value: number | undefined): string {
  return value === undefined ? '-' : `${(value * 100).toFixed(1)}%`;
}

function number(value: number | undefined, digits: number): string {
  return value === undefined ? '-' : value.toFixed(digits);
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
