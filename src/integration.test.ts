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
import { type AgentTransport, Controller, type RunResult } from './controller.js';
import { FleetAgent } from './agent/agent.js';
import type { Channel } from './transport/channel.js';
import { localChannelPair } from './transport/local.js';
import type { FromAgent, ToAgent } from './transport/protocol.js';
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
  // Twelve segments rather than the usual six: this is the test that asserts
  // resource sampling reached the report, and CPU utilisation is a difference
  // between two ticks. At 250 ms a ~1 s run produces one or two ticks, so the
  // assertion came down to whether the second one landed before the run ended.
  const { result, dir } = await runScenario({ viewers: 4, segments: 12 });

  assert.equal(result.valid, true, result.invalidBecause.join('; '));
  assert.equal(result.kpis.viewers.started, 4);
  assert.equal(result.kpis.viewers.byOutcome.completed, 4);
  assert.equal(result.kpis.segments, 48);
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

/**
 * The failure this rig could not previously see: viewers acquire their peers
 * and then have them taken away, so the fleet generates a fraction of the
 * connection load it was asked for while every other guard reads healthy. The
 * box that motivated it had 122 cores at a load of 3.27 and 196 GB free.
 */
test('viewers that lose the peers they acquired invalidate the run', async () => {
  const { result } = await runScenario({
    viewers: 3,
    segments: 200,
    env: { ...FAST_ENV, MOCK_PEERS_EVICT_AFTER_MS: '2000', MOCK_PEERS_EVICT_TO: '0.3' },
  });

  assert.equal(result.valid, false);
  assert.match(result.invalidBecause.join(' '), /peer_target/);
  // Named as eviction, because that points somewhere different from starvation.
  assert.match(result.invalidBecause.join(' '), /reached the target then lost it/);
  assert.match(result.invalidBecause.join(' '), /NAT|conntrack/);
});

test('a cohort that holds its peer footprint passes the peer guard', async () => {
  const { result } = await runScenario({ viewers: 3 });
  const peer = result.agents
    .flatMap((agent) => agent.guards ?? [])
    .find((guard) => guard.name === 'peer_target');
  assert.ok(peer !== undefined, 'no peer_target verdict');
  assert.equal(peer.status, 'ok');
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

test('a settled cohort peers in full, is released together, and measures only after', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-test-'));
  const scenario = resolveScenario({
    mode: 'cohort',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    segments: 6,
    viewers: 4,
    peerLimit: 40,
    settle: { timeoutS: 20 },
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 3_000,
    maxRunS: 60,
    env: FAST_ENV,
  });
  assert.deepEqual(scenario.settle, { peerUp: 40, timeoutS: 20 });
  assert.equal(scenario.spec.hold, true);
  assert.equal(scenario.spec.peerUp, 40);

  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);
  // The stream would start here in a publishing run. Recording when it was
  // called is what proves the ordering: the audience is in place first.
  let settledAt: number | undefined;
  let heldWhenSettled = 0;
  const controller = new Controller(scenario, id, dir, {
    onSettled: async () => {
      settledAt = Date.now();
      heldWhenSettled = 4;
    },
  });
  const result = await controller.run(false);

  assert.equal(result.valid, true, result.invalidBecause.join('; '));
  assert.equal(result.kpis.viewers.started, 4);
  assert.equal(result.kpis.viewers.byOutcome.completed, 4);
  assert.equal(heldWhenSettled, 4);
  assert.ok(settledAt !== undefined, 'onSettled ran');

  // The barrier held every viewer at its full peer footprint, and each was
  // released rather than releasing itself on a closed stdin.
  for (const record of result.records) {
    assert.ok((record.heldAtPeers ?? 0) >= 40, `${record.viewerId} held at ${record.heldAtPeers}`);
    assert.equal(record.held, false, `${record.viewerId} was released`);
    assert.ok((record.heldMs ?? 0) > 0);
  }

  // The measurement window excludes the settle phase, so it is shorter than
  // the run, and the KPI rates are divided by it rather than by the whole run.
  assert.ok(result.settleS > 0);
  const summary = buildSummary(result);
  assert.ok(
    summary.measuredS < summary.durationS,
    `measured ${summary.measuredS}s of a ${summary.durationS}s run`,
  );
  assert.match(renderReport(summary), /settling the cohort/);
  assert.deepEqual(
    result.caveats.filter((caveat) => caveat.includes('released before it had settled')),
    [],
  );
});

test('a settle phase that times out releases anyway and says so', async () => {
  const { result } = await runScenario({
    viewers: 2,
    peerLimit: 40,
    // Nothing can reach 400 peers, so the deadline is what releases the cohort.
    settle: { peerUp: 400, timeoutS: 2 },
  });

  assert.match(result.caveats.join(' '), /released before it had settled/);
  assert.equal(result.kpis.viewers.started, 2);
  // Released and measured regardless: a shortfall is a caveat, not a failure.
  assert.equal(result.kpis.viewers.byOutcome.completed, 2);
});

test('settle and ramp are refused together', () => {
  assert.throws(
    () =>
      resolveScenario({
        mode: 'ramp',
        binary: 'mock',
        streams: [{ owner: 'aa', topic: 'bb' }],
        settle: true,
      }),
    /settle and ramp are alternatives/,
  );
});

/**
 * A held viewer's duration clock starts at release, and the bound has to agree.
 *
 * The straggler bound was measured from the last viewer's *start*, but a viewer
 * under `--hold` parks inside `peer_up` and only takes its playback clock once
 * released. Everything a settled run does in between — for `--publish`, the
 * whole of `handle.joinable()`: ffmpeg coming up and writing 8 s of runway into
 * Swarm — was therefore charged against the viewers' own duration, so the bound
 * came due before they had watched anything and a healthy cohort was killed
 * mid-measurement and reported as hung.
 *
 * The delay here stands in for that publisher wait, and is longer than
 * `durationS + stragglerGraceS` on purpose: that is precisely the window the
 * old bound got wrong.
 */
test('a settled cohort is not charged for the time it spent held', async () => {
  const publisherStartupMs = 5_000;
  const scenario = resolveScenario({
    mode: 'cohort',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    viewers: 2,
    durationS: 2,
    stragglerGraceS: 1,
    settle: { peerUp: 20, timeoutS: 30 },
    peerLimit: 20,
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 1_000,
    maxRunS: 120,
    env: FAST_ENV,
  });
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-test-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);

  let settledAtMs = 0;
  const controller = new Controller(scenario, id, dir, {
    onSettled: async () => {
      settledAtMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, publisherStartupMs));
    },
  });
  const result = await controller.run(false);

  // The delay was real, or the test is no longer exercising anything.
  assert.ok(settledAtMs > 0, 'the cohort never settled');

  assert.match(result.stoppedBecause, /finished/);
  assert.doesNotMatch(result.stoppedBecause, /hung/);
  assert.ok(
    !result.invalidBecause.some((reason) => /outliving their duration/.test(reason)),
    result.invalidBecause.join('; '),
  );
  // Killed viewers lose their summary, so a full set of them is the other half
  // of the claim: these two watched to the end of their own duration.
  assert.equal(result.kpis.viewers.started, 2);
  assert.equal(result.kpis.viewers.byOutcome.completed, 2);
});

// The shutdown tests live last on purpose. They spawn viewers that ignore
// SIGTERM, and `machine_idle` refuses a box that is already busy — so leaving
// their load in front of another test's preflight makes that test flaky for a
// reason that has nothing to do with what it checks.

/**
 * The four failures that lost the first Vultr fleet run.
 *
 * 250 viewers watched a live mainnet stream for their full 120 s and the rig
 * threw all of it away: six viewers never ended, the run loop waited for them
 * instead of stopping them, the abort path did not interrupt that wait, and
 * every viewer record was held in memory until a `collect` that never came.
 */
test('viewers that outlive their duration are stopped, not waited for', async () => {
  const started = Date.now();
  const { result, dir } = await runScenario({
    viewers: 3,
    segments: undefined,
    durationS: 1,
    stragglerGraceS: 2,
    graceMs: 1_000,
    // A ceiling far beyond the straggler bound, so the timing says which one
    // ended the run: waiting for the ceiling would take two minutes.
    maxRunS: 120,
    env: { ...FAST_ENV, MOCK_HANG: '1', MOCK_IGNORE_SIGTERM: '1' },
  });

  const elapsedS = (Date.now() - started) / 1000;
  assert.ok(elapsedS < 30, `run took ${elapsedS.toFixed(1)}s; the straggler bound did not fire`);
  assert.match(result.stoppedBecause, /stopped as hung/);

  // A killed viewer never emitted its summary, so the run cannot claim to
  // describe the fleet it names.
  assert.equal(result.valid, false);
  assert.ok(
    result.invalidBecause.some((reason) => /outliving their duration/.test(reason)),
    result.invalidBecause.join('; '),
  );

  // A viewer that had to be killed still leaves the events it emitted before
  // it hung, because they were written as they arrived.
  const files = await readdir(path.join(dir, 'viewers'));
  assert.ok(files.some((file) => file.endsWith('.ndjson')), `no viewer records in ${files.join()}`);
});

test('abort interrupts the run loop instead of waiting it out', async () => {
  const scenario = resolveScenario({
    mode: 'cohort',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    viewers: 2,
    durationS: 300,
    // Hung viewers with a straggler grace beyond the ceiling: nothing but the
    // abort can end this run, which is the point.
    stragglerGraceS: 600,
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 2_000,
    maxRunS: 600,
    env: { ...FAST_ENV, MOCK_HANG: '1' },
  });
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-test-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);
  const controller = new Controller(scenario, id, dir, {});

  const running = controller.run(false);
  // Long enough for both viewers to be up and emitting.
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const started = Date.now();
  await controller.abort('SIGINT');
  const result = await running;
  const elapsedS = (Date.now() - started) / 1000;

  // The bug: `driveFixed` waited on a condition that never tested `aborted`,
  // so Ctrl-C did nothing until the run's own ceiling — 600 s here.
  assert.ok(elapsedS < 60, `abort took ${elapsedS.toFixed(1)}s to be noticed`);
  assert.match(result.stoppedBecause, /aborted/);
  assert.equal(result.valid, false);

  // And it still reported: an aborted run is a short run, not a lost one.
  const files = await readdir(path.join(dir, 'viewers'));
  assert.ok(files.some((file) => file.endsWith('.ndjson')), `no viewer records in ${files.join()}`);
});

/**
 * A machine can leave in the middle of a run, and the rest must carry on.
 *
 * Measured the hard way: a 20-machine, 1000-viewer settled cohort lost two
 * boxes during the join, and the other 900 viewers sat parked at the barrier —
 * peered, idle, watching nothing — because the barrier was still waiting for
 * 100 viewers on machines that no longer existed. The run had to be killed
 * before it measured anything at all.
 *
 * The transport is injected so the test can hold one end of a control channel
 * and cut it, which is the only way to lose a machine without an ssh server and
 * a network to break. `settle.timeoutS` is far longer than the test: if the
 * barrier waited out the deadline instead of shrinking to the fleet that was
 * left, this would fail by timing out rather than by assertion.
 */
test('a machine lost mid-settle does not strand the cohort behind the barrier', async () => {
  const scenario = resolveScenario({
    mode: 'cohort',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    segments: 6,
    viewers: 4,
    peerLimit: 40,
    agents: [
      { host: 'local', name: 'steady', weight: 1 },
      { host: 'local', name: 'doomed', weight: 1 },
    ],
    settle: { timeoutS: 120 },
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 3_000,
    maxRunS: 60,
    // Slower to peer than the other tests, so the settle phase is long enough
    // to lose a machine inside it — which is when this happened for real.
    env: { ...FAST_ENV, MOCK_PEERS_RAMP_MS: '4000' },
  });

  let lostAlready = false;
  const transport: AgentTransport = (target) => {
    const pair = localChannelPair();
    void new FleetAgent(pair.agentSide).start();
    if ((target.name ?? target.host) !== 'doomed') {
      return { channel: pair.controllerSide };
    }
    // Cut the moment this machine reports a viewer parked at the barrier: a
    // machine the cohort is counting on, with live viewers on it, vanishing
    // mid-settle. Driven off its own messages rather than a timer, so the
    // instant is the same on every machine this test runs on.
    const channel: Channel<ToAgent, FromAgent> = {
      ...pair.controllerSide,
      onMessage: (handler) =>
        pair.controllerSide.onMessage((message) => {
          handler(message);
          if (!lostAlready && message.kind === 'state' && message.held >= 1) {
            lostAlready = true;
            setImmediate(() => pair.controllerSide.close());
          }
        }),
    };
    return { channel };
  };

  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-test-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);
  let released = false;
  const controller = new Controller(
    scenario,
    id,
    dir,
    {
      onSettled: async () => {
        released = true;
      },
    },
    transport,
  );
  const result = await controller.run(false);

  assert.equal(lostAlready, true, 'the doomed agent was cut');
  assert.equal(released, true, 'the cohort was released rather than left at the barrier');
  // The barrier opened on the fleet that was left rather than waiting out the
  // 120 s deadline for viewers that no longer existed. This is the assertion
  // the whole test is for.
  assert.ok(result.settleS < 30, `settled in ${result.settleS.toFixed(1)}s`);

  // The survivors watched their whole run: this is the recovery.
  assert.equal(result.kpis.viewers.byOutcome.completed, 2);
  assert.equal(result.kpis.segments, 12);
  // The lost machine's viewers are their own outcome, not `running` for ever
  // and not counted among the viewers this fleet was generating load with.
  assert.equal(result.kpis.viewers.byOutcome.agent_lost, 2);
  assert.equal(result.kpis.viewers.watching, 0);

  // And the run says what happened: a fleet that shrank measured less load
  // than it was asked for, whatever the survivors managed.
  assert.equal(result.valid, false);
  assert.match(result.invalidBecause.join(' '), /agent doomed disconnected/);
  assert.match(result.caveats.join(' '), /machines left the fleet mid-run/);
});
