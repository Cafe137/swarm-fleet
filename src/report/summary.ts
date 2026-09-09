/**
 * `summary.json`: every KPI, plus the verdict on whether to believe them.
 *
 * Written so a supervisor or a spreadsheet never has to parse a log line, and
 * so the validity verdict travels with the numbers rather than living in
 * someone's memory of the run.
 */

import type { AgentReport, RunResult } from '../controller.js';
import type { GuardVerdict } from '../metrics/guard.js';
import type { MachineSample } from '../transport/protocol.js';

export interface RunSummary {
  runId: string;
  label: string;
  mode: string;
  startedAt: string;
  /**
   * Seconds spent peering the cohort before it was released, and the window the
   * KPIs are actually divided by. Zero and equal to `durationS` for a run with
   * no settle phase.
   */
  settleS: number;
  measuredS: number;
  endedAt: string;
  durationS: number;
  stoppedBecause: string;
  verdict: {
    valid: boolean;
    comparable: boolean;
    invalidBecause: string[];
    caveats: string[];
  };
  kpis: RunResult['kpis'];
  rampSteps: RunResult['rampSteps'];
  guards: Record<string, GuardVerdict[]>;
  machines: Record<string, MachineSummary>;
  viewers: RunResult['records'];
}

/**
 * One machine's contribution to a run, as the report and any spreadsheet
 * downstream of it read it. Optional fields are genuinely optional: a platform
 * that would not give the agent a counter reports nothing rather than a zero.
 */
export interface MachineSummary {
  host: string;
  machine: AgentReport['machine'];
  preflight: AgentReport['preflight'];
  clockOffsetMs?: number | undefined;
  viewersStarted: number;
  samples: number;
  peakLoadAvg1: number;
  peakViewerRssBytes: number;
  peakAgentRssBytes: number;
  peakEstablishedSockets: number;
  peakCpuUtilisation?: number | undefined;
  peakRxMbps?: number | undefined;
  peakTxMbps?: number | undefined;
  wireRxBytes?: number | undefined;
  wireTxBytes?: number | undefined;
}

export function buildSummary(result: RunResult): RunSummary {
  const guards: Record<string, GuardVerdict[]> = {};
  const machines: Record<string, MachineSummary> = {};
  for (const agent of result.agents) {
    guards[agent.name] = agent.guards;
    machines[agent.name] = {
      host: agent.host,
      machine: agent.machine,
      preflight: agent.preflight,
      clockOffsetMs: agent.clockOffsetMs,
      viewersStarted: agent.viewersStarted,
      samples: agent.samples.length,
      peakLoadAvg1: agent.samples.reduce((peak, sample) => Math.max(peak, sample.loadAvg1), 0),
      peakViewerRssBytes: agent.samples.reduce(
        (peak, sample) => Math.max(peak, sample.viewerRssTotalBytes),
        0,
      ),
      peakAgentRssBytes: agent.samples.reduce(
        (peak, sample) => Math.max(peak, sample.agentRssBytes),
        0,
      ),
      peakEstablishedSockets: agent.samples.reduce(
        (peak, sample) => Math.max(peak, sample.establishedSockets ?? 0),
        0,
      ),
      peakCpuUtilisation: peak(agent.samples, (sample) => sample.cpuUtilisation),
      peakRxMbps: mbps(peak(agent.samples, (sample) => sample.rxBytesPerSec)),
      peakTxMbps: mbps(peak(agent.samples, (sample) => sample.txBytesPerSec)),
      // Counters are cumulative for the whole machine, so the run's own wire
      // cost is the span between the first and last sample. It includes
      // anything else on the box, which is why a run that shares a machine
      // carries a caveat saying so.
      wireRxBytes: span(agent.samples, (sample) => sample.rxBytes),
      wireTxBytes: span(agent.samples, (sample) => sample.txBytes),
    };
  }

  return {
    runId: result.runId,
    label: result.label,
    mode: result.mode,
    startedAt: new Date(result.startedAtMs).toISOString(),
    endedAt: new Date(result.endedAtMs).toISOString(),
    settleS: result.settleS,
    measuredS: (result.endedAtMs - result.measuredFromMs) / 1000,
    durationS: result.durationS,
    stoppedBecause: result.stoppedBecause,
    verdict: {
      valid: result.valid,
      comparable: result.comparable,
      invalidBecause: result.invalidBecause,
      caveats: result.caveats,
    },
    kpis: result.kpis,
    rampSteps: result.rampSteps,
    guards,
    machines,
    viewers: result.records,
  };
}

/** Peak of an optional series, or undefined when nothing reported it. */
function peak(
  samples: readonly MachineSample[],
  pick: (sample: MachineSample) => number | undefined,
): number | undefined {
  let worst: number | undefined;
  for (const sample of samples) {
    const value = pick(sample);
    if (value !== undefined && (worst === undefined || value > worst)) {
      worst = value;
    }
  }
  return worst;
}

/** First-to-last difference of a cumulative counter. */
function span(
  samples: readonly MachineSample[],
  pick: (sample: MachineSample) => number | undefined,
): number | undefined {
  let first: number | undefined;
  let last: number | undefined;
  for (const sample of samples) {
    const value = pick(sample);
    if (value === undefined) {
      continue;
    }
    first = first ?? value;
    last = value;
  }
  return first === undefined || last === undefined || last < first ? undefined : last - first;
}

function mbps(bytesPerSecond: number | undefined): number | undefined {
  return bytesPerSecond === undefined ? undefined : (bytesPerSecond * 8) / 1e6;
}
