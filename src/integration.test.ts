/**
 * End to end through the real code path: controller, local transport, agent,
 * admission, spawned viewer processes, rollup, aggregation, guards, report.
 *
 * The viewers are the built-in mock, sped up so a run finishes in a couple of
 * seconds. That is the whole point of the mock existing: everything except the
 * Swarm client itself is exercised here, on every `npm test`, with no mainnet
 * traffic and nothing to wait for.
 *
 * These runs judge the machine they run on — `machine_idle` refuses a box that
 * is already busy — so `npm test` passes `--test-concurrency=1`. Test files
 * running in parallel would load the machine enough to make a real preflight
 * refusal look like a flaky test.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller, type RunResult } from './controller.js';
import { renderReport } from './report/markdown.js';
import { buildSummary } from './report/summary.js';
import { createRunDir, runId } from './run-dir.js';
import { resolveScenario, type Scenario } from './scenario.js';

const FAST_ENV = {
  MOCK_SPEED: '40',
  MOCK_PEERS_RAMP_MS: '1000',
  MOCK_FETCH_MS: '400',
  MOCK_BODY_FAILURE_RATE: '0',
};

async function runScenario(overrides: Partial<Scenario>): Promise<{
  result: RunResult;
  dir: string;
}> {
  const scenario = resolveScenario({
    mode: 'cohort',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    segments: 6,
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 3_000,
    maxRunS: 60,
    env: FAST_ENV,
    ...overrides,
  });
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-test-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);
  const controller = new Controller(scenario, id, dir, {});
  return { result: await controller.run(false), dir };
}

test('a cohort runs, reports, and leaves a readable run directory', async () => {
  const { result, dir } = await runScenario({ viewers: 4 });

  assert.equal(result.valid, true, result.invalidBecause.join('; '));
  assert.equal(result.kpis.viewers.started, 4);
  assert.equal(result.kpis.viewers.byOutcome.completed, 4);
  assert.equal(result.kpis.segments, 24);
  assert.ok(result.kpis.bytes > 0);
  assert.equal(result.kpis.joinSuccessRate, 1);
  assert.equal(result.kpis.degradedFraction, 0);
  assert.match(result.stoppedBecause, /finished/);

  // Every viewer left both its raw events and its human log behind.
  const files = await readdir(path.join(dir, 'viewers'));
  assert.equal(files.filter((file) => file.endsWith('.ndjson')).length, 4);
  assert.equal(files.filter((file) => file.endsWith('.log')).length, 4);

  const manifest = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')) as {
    agents: { machine: { cores: number } }[];
    resolved: { spec: { binary: string } };
  };
  assert.equal(manifest.resolved.spec.binary, 'mock');
  assert.ok((manifest.agents[0]?.machine.cores ?? 0) > 0);

  // The report renders, and says out loud that a mock proves nothing about Swarm.
  const summary = buildSummary(result);
  const report = renderReport(summary);
  assert.match(report, /Viewers degraded/);
  assert.match(report, /measures the rig, not Swarm/);

  // Machine resources reached the report. CPU utilisation comes from tick
  // counters that exist on every platform; interface counters do not, so they
  // are allowed to be absent rather than asserted into existence.
  assert.match(report, /\| Machine \| Cores \| Viewers \|/);
  const machine = summary.machines['local'];
  assert.ok(machine !== undefined);
  assert.ok(
    (machine.peakCpuUtilisation ?? -1) >= 0,
    'a run long enough to sample twice has a CPU utilisation figure',
  );
  assert.ok(machine.peakViewerRssBytes > 0);
});

test('injected stalls show up as degraded viewers', async () => {
  const { result } = await runScenario({
    viewers: 3,
    segments: 12,
    // 400 ms median fetch at 8x is 3.2 s for a 2 s segment: the buffer drains.
    env: { ...FAST_ENV, MOCK_STALL_BIAS: '8', MOCK_FETCH_JITTER: '0.1' },
  });

  assert.equal(result.kpis.viewers.started, 3);
  assert.ok(
    (result.kpis.degradedFraction ?? 0) > 0,
    `expected degraded viewers, got ${String(result.kpis.degradedFraction)}`,
  );
  assert.ok(
    (result.kpis.realtimeFactorP95 ?? 0) > 1,
    'a viewer losing buffer must show a realtime factor above 1',
  );
});

test('viewers that crash invalidate the run rather than shrinking it quietly', async () => {
  const { result } = await runScenario({
    viewers: 3,
    segments: 200,
    env: { ...FAST_ENV, MOCK_CRASH_AFTER_MS: '600' },
  });

  assert.equal(result.kpis.viewers.byOutcome.crashed, 3);
  assert.equal(result.valid, false);
  assert.match(result.invalidBecause.join(' '), /crashed or never joined/);
});

test('body failures are counted, at roughly the rate they are injected', async () => {
  const { result } = await runScenario({
    viewers: 4,
    segments: 25,
    env: { ...FAST_ENV, MOCK_BODY_FAILURE_RATE: '0.2' },
  });

  assert.ok(result.kpis.bodyFailureRate !== undefined);
  assert.ok(
    (result.kpis.bodyFailureRate ?? 0) > 0.05,
    `expected an injected failure rate to show, got ${String(result.kpis.bodyFailureRate)}`,
  );
  assert.equal(result.valid, true, result.invalidBecause.join('; '));
});

test('one stream across many viewers is flagged as a popularity test', async () => {
  const { result } = await runScenario({ viewers: 3 });
  assert.match(result.caveats.join(' '), /forwarding-node caching/);

  const spread = await runScenario({
    viewers: 3,
    assignment: 'round-robin',
    streams: [
      { owner: 'aa', topic: 'one' },
      { owner: 'aa', topic: 'two' },
      { owner: 'aa', topic: 'three' },
    ],
  });
  assert.equal(spread.result.kpis.distinctContentRatio, 1);
  assert.doesNotMatch(spread.result.caveats.join(' '), /forwarding-node caching/);
});
