/** `report.md`: the human read of a run. */

import type { RunSummary } from './summary.js';

export function renderReport(summary: RunSummary): string {
  const lines: string[] = [];
  const kpis = summary.kpis;

  lines.push(`# ${summary.label}`);
  lines.push('');
  lines.push(
    `\`${summary.mode}\` run \`${summary.runId}\`, ${summary.durationS.toFixed(0)}s. ` +
      `Stopped because: ${summary.stoppedBecause}.`,
  );
  lines.push('');

  if (!summary.verdict.valid) {
    lines.push('## This run is INVALID');
    lines.push('');
    lines.push(
      'A guard KPI breached, which means these numbers describe the load generator rather ' +
        'than Swarm. They are recorded for diagnosis, not for capacity planning.',
    );
    lines.push('');
    for (const reason of summary.verdict.invalidBecause) {
      lines.push(`-   ${reason}`);
    }
    lines.push('');
  }

  if (!summary.verdict.comparable) {
    lines.push('> **Not comparable with other runs.** This scenario deliberately breaks a');
    lines.push('> measurement rule; see the caveats.');
    lines.push('');
  }

  lines.push('## Headline');
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Viewers degraded | **${percent(kpis.degradedFraction)}** (${kpis.degradedViewers} of ${kpis.viewers.started}) |`);
  lines.push(`| Stall ratio p50 / p95 | ${percent(kpis.stallRatio.p50)} / ${percent(kpis.stallRatio.p95)} |`);
  lines.push(`| Entirely stall-free | ${percent(kpis.stallFreeFraction)} |`);
  lines.push(`| Join success | ${percent(kpis.joinSuccessRate)} |`);
  lines.push(`| Join latency p95 | ${millis(kpis.joinMs.p95)} |`);
  lines.push(`| Realtime factor p95 | ${fixed(kpis.realtimeFactorP95, 2)} ${realtimeNote(kpis.realtimeFactorP95)} |`);
  lines.push(`| Aggregate throughput | ${fixed(kpis.aggregateMbps, 1)} Mbps |`);
  lines.push(`| Delivered | ${kpis.segments} segments, ${mib(kpis.bytes)} |`);
  lines.push(`| Body failure rate | ${percent(kpis.bodyFailureRate)} |`);
  lines.push(`| Segments skipped | ${kpis.skippedTotal} |`);
  lines.push(`| Peer connections held | ${kpis.peersTotal} |`);
  lines.push('');

  lines.push('## Viewers');
  lines.push('');
  lines.push('| Outcome | Count |');
  lines.push('| --- | --- |');
  for (const [outcome, count] of Object.entries(kpis.viewers.byOutcome)) {
    if (count > 0) {
      lines.push(`| ${outcome.replace(/_/g, ' ')} | ${count} |`);
    }
  }
  lines.push(`| **requested** | ${kpis.viewers.requested} |`);
  lines.push(`| **started** | ${kpis.viewers.started} |`);
  lines.push('');

  if (summary.rampSteps.length > 0) {
    lines.push('## Capacity curve');
    lines.push('');
    lines.push('| Target | Active | Degraded | Realtime p95 | Join success | Mbps |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const step of summary.rampSteps) {
      lines.push(
        `| ${step.target} | ${step.active} | ${percent(step.degradedFraction)} | ` +
          `${fixed(step.realtimeFactorP95, 2)} | ${percent(step.joinSuccessRate)} | ` +
          `${fixed(step.aggregateMbps, 1)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Guards');
  lines.push('');
  lines.push('| Agent | Guard | Status | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const [agent, verdicts] of Object.entries(summary.guards)) {
    for (const verdict of verdicts) {
      const status = verdict.status === 'breached' ? '**BREACHED**' : verdict.status;
      lines.push(`| ${agent} | ${verdict.name} | ${status} | ${verdict.detail} |`);
    }
  }
  lines.push('');

  const worst = [...summary.viewers]
    .filter((viewer) => viewer.stallRatio !== undefined)
    .sort((left, right) => (right.stallRatio ?? 0) - (left.stallRatio ?? 0))
    .slice(0, 5);
  if (worst.length > 0) {
    lines.push('## Worst five viewers');
    lines.push('');
    lines.push('| Viewer | Stall ratio | Stalls | Segments | Fetch p95 | Min buffer | Outcome |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const viewer of worst) {
      lines.push(
        `| ${viewer.viewerId} | ${percent(viewer.stallRatio)} | ${viewer.stalls} | ` +
          `${viewer.segments} | ${millis(viewer.fetchMs.p95)} | ` +
          `${fixed(viewer.minBufferedS, 2)}s | ${viewer.outcome} |`,
      );
    }
    lines.push('');
  }

  if (summary.verdict.caveats.length > 0) {
    lines.push('## Caveats');
    lines.push('');
    for (const caveat of summary.verdict.caveats) {
      lines.push(`-   ${caveat}`);
    }
    lines.push('');
  }

  lines.push('## Machines');
  lines.push('');
  lines.push('| Machine | Cores | Viewers | Peak load | Peak CPU | Peak viewer RSS | Peak rx/tx | Wire in | Peak sockets |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, machine] of Object.entries(summary.machines)) {
    const cores = machine.machine?.cores;
    lines.push(
      `| ${name} (${machine.host}) | ${cores ?? 'n/a'} | ${machine.viewersStarted} | ` +
        `${machine.peakLoadAvg1.toFixed(2)} | ${percent(machine.peakCpuUtilisation)} | ` +
        `${mib(machine.peakViewerRssBytes)} | ` +
        `${fixed(machine.peakRxMbps, 1)} / ${fixed(machine.peakTxMbps, 1)} Mbps | ` +
        `${machine.wireRxBytes === undefined ? 'n/a' : mib(machine.wireRxBytes)} | ` +
        `${machine.peakEstablishedSockets} |`,
    );
  }
  lines.push('');

  const wire = wireBytes(summary);
  if (wire !== undefined && kpis.bytes > 0) {
    const ratio = wire / kpis.bytes;
    lines.push(
      `Interface counters recorded **${mib(wire)}** into the fleet's machines against ` +
        `**${mib(kpis.bytes)}** of media delivered: a wire-to-media ratio of ` +
        `**${ratio.toFixed(2)}x**.`,
    );
    lines.push('');
    lines.push(
      ratio >= 1
        ? 'The surplus is Swarm\'s retrieval overhead — chunk requests, intermediate BMT ' +
            'chunks, retried and duplicated fetches, peer maintenance — plus anything else ' +
            'sharing those NICs, which is why a machine that also ran the publisher or the ' +
            'controller makes this an upper bound rather than a measurement.'
        : 'Less arrived over the wire than was delivered as media, so the viewers were not ' +
            'the source of this traffic: either they were mocks, or the run was too short ' +
            'for a 1 Hz counter to see it, or the interfaces the fleet actually used were ' +
            'not the ones being counted. Treat this ratio as unmeasured.',
    );
    lines.push('');
  }

  return lines.join('\n');
}

function realtimeNote(value: number | undefined): string {
  if (value === undefined) {
    return '';
  }
  return value > 1
    ? '(above 1: the tail of the fleet was losing buffer)'
    : '(below 1: segments arrived faster than they play)';
}

function percent(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function fixed(value: number | undefined, digits: number): string {
  return value === undefined ? 'n/a' : value.toFixed(digits);
}

function millis(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${value.toFixed(0)} ms`;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Bytes the fleet's interfaces took in over the run.
 *
 * Undefined unless every machine reported counters: a partial total read as a
 * fleet total would understate the ratio below it, and an understated overhead
 * is the error that matters here.
 */
function wireBytes(summary: RunSummary): number | undefined {
  const machines = Object.values(summary.machines);
  if (machines.length === 0 || machines.some((machine) => machine.wireRxBytes === undefined)) {
    return undefined;
  }
  return machines.reduce((total, machine) => total + (machine.wireRxBytes ?? 0), 0);
}
