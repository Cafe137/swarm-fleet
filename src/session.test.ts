/**
 * A session, driven the way a participant drives one: start, scale up, scale
 * down, stop.
 *
 * The mock viewer stands in for the real one, so this exercises the whole path
 * — controller, transport, agent, admission, spawned processes, the shed — on
 * every `npm test` with no mainnet traffic.
 */

import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller, type LiveSnapshot } from './controller.js';
import { createRunDir, runId } from './run-dir.js';
import { resolveScenario } from './scenario.js';

const FAST_ENV = {
  MOCK_SPEED: '40',
  MOCK_PEERS_RAMP_MS: '500',
  MOCK_FETCH_MS: '200',
  MOCK_BODY_FAILURE_RATE: '0',
};

async function eventually(
  predicate: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('a session scales up and down on demand, and ends when it is told to', async () => {
  const scenario = resolveScenario({
    mode: 'session',
    profile: 'participant',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    viewers: 2,
    durationS: 600,
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 2_000,
    env: FAST_ENV,
  });
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-session-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);

  let latest: LiveSnapshot | undefined;
  const controller = new Controller(scenario, id, dir, {
    onSnapshot: (snapshot) => {
      latest = snapshot;
    },
  });
  const running = controller.run(false);

  await eventually(() => (latest?.active ?? 0) >= 2, 'the first two viewers');
  assert.equal(controller.target(), 2);

  controller.setViewerTarget(5);
  await eventually(() => (latest?.active ?? 0) >= 5, 'the session to scale up to five');

  controller.setViewerTarget(1);
  await eventually(() => (latest?.active ?? 0) === 1, 'the session to shed down to one');

  await controller.abort('test');
  const result = await running;

  // Shedding is not failing: the viewers that were stopped are `killed`, and a
  // session that scaled down must not report a fleet that fell over.
  assert.equal(result.kpis.viewers.byOutcome.crashed, 0, JSON.stringify(result.invalidBecause));
  assert.ok(result.kpis.viewers.started >= 5, `started ${result.kpis.viewers.started}`);
  assert.equal(result.mode, 'session');
  // The high-water mark is what was ever asked for, not what was held at the end.
  assert.ok(
    result.rampSteps.some((step) => step.target === 5),
    'the scale-up should be recorded as a step',
  );
});

test('a session can be scaled up and down all evening without running out of starts', async () => {
  // The agent launches against a start budget, which is what stops a bounded
  // cohort from relaunching its viewers for ever. A session has to be able to
  // keep starting them: viewers retire after an hour and are replaced, and a
  // participant plays with the arrow keys for two hours. Held to a budget that
  // only ever accumulated the largest target, the third scale-up here stalls
  // part way — a laptop that quietly stops filling its own target while the
  // dashboard says it should be at six.
  const scenario = resolveScenario({
    mode: 'session',
    profile: 'participant',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    viewers: 2,
    durationS: 600,
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 2_000,
    env: FAST_ENV,
  });
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-session-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);

  let latest: LiveSnapshot | undefined;
  const controller = new Controller(scenario, id, dir, {
    onSnapshot: (snapshot) => {
      latest = snapshot;
    },
  });
  const running = controller.run(false);
  await eventually(() => (latest?.active ?? 0) >= 2, 'the first two viewers');

  for (let round = 0; round < 3; round += 1) {
    controller.setViewerTarget(6);
    await eventually(() => (latest?.active ?? 0) === 6, `six viewers on round ${round + 1}`);
    controller.setViewerTarget(1);
    await eventually(() => (latest?.active ?? 0) === 1, `one viewer on round ${round + 1}`);
  }

  await controller.abort('test');
  const result = await running;
  assert.ok(
    result.kpis.viewers.started >= 16,
    `only ${result.kpis.viewers.started} viewers were ever started`,
  );
});

test('a finished run leaves nothing of itself running', async () => {
  // A session restarts its run whenever the publisher moves, so anything a
  // finished run keeps alive is kept alive once per restart for the rest of the
  // event. The local agent's sampler is the one that matters: left ticking, each
  // ghost forks `ps` once a second on a participant's laptop and appends to a
  // run directory nobody is looking at any more.
  const scenario = resolveScenario({
    mode: 'session',
    profile: 'participant',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    viewers: 1,
    durationS: 600,
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 200,
    graceMs: 2_000,
    env: FAST_ENV,
  });
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-session-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);
  let latest: LiveSnapshot | undefined;
  const controller = new Controller(scenario, id, dir, {
    onSnapshot: (snapshot) => {
      latest = snapshot;
    },
  });
  const running = controller.run(false);
  await eventually(() => (latest?.active ?? 0) >= 1, 'the viewer to start');
  await controller.abort('test');
  await running;

  const machineLog = path.join(dir, 'machines', 'local.ndjson');
  const settled = (await stat(machineLog)).size;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(
    (await stat(machineLog)).size,
    settled,
    'the machine log grew after the run ended, so its sampler is still going',
  );
});

test("a participant's run is not invalidated by the machine it ran on", async () => {
  const scenario = resolveScenario({
    mode: 'session',
    profile: 'participant',
    binary: 'mock',
    streams: [{ owner: 'aabb', topic: 'ccdd' }],
    viewers: 1,
    durationS: 600,
    admission: { minStartIntervalMs: 10, startJitterMs: 0 },
    sampleIntervalMs: 250,
    graceMs: 2_000,
    env: FAST_ENV,
  });
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-session-'));
  const id = runId(scenario.label);
  const dir = await createRunDir(runsDir, id);
  let latest: LiveSnapshot | undefined;
  const controller = new Controller(scenario, id, dir, {
    onSnapshot: (snapshot) => {
      latest = snapshot;
    },
  });
  const running = controller.run(false);
  await eventually(() => (latest?.active ?? 0) >= 1, 'the viewer to start');
  await controller.abort('test');
  const result = await running;

  assert.equal(result.valid, true, result.invalidBecause.join('; '));
  assert.ok(
    result.caveats.some((caveat) => caveat.includes("participant's own machine")),
    'the report must say whose machine this was',
  );
});
