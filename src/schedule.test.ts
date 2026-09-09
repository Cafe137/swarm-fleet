import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdmissionGate, CostModel, DEFAULT_ADMISSION, partition } from './schedule.js';

const noJitter = { ...DEFAULT_ADMISSION, startJitterMs: 0 };

test('the gate admits the first viewer immediately', () => {
  const gate = new AdmissionGate(8, noJitter, new CostModel(), () => 0);
  const decision = gate.decide(0, { bootstrapping: 0, running: 0 });
  assert.equal(decision.admit, true);
});

test('the minimum interval holds off a second start', () => {
  const gate = new AdmissionGate(8, noJitter, new CostModel(), () => 0);
  gate.noteStart(1_000);
  const tooSoon = gate.decide(1_100, { bootstrapping: 1, running: 0 });
  assert.equal(tooSoon.admit, false);
  assert.equal(tooSoon.reason, 'minimum start interval');
  assert.equal(tooSoon.retryAfterMs, 150);
  assert.equal(gate.decide(1_250, { bootstrapping: 1, running: 0 }).admit, true);
});

test('the cpu budget refuses a flood on eight cores', () => {
  const gate = new AdmissionGate(8, noJitter, new CostModel(), () => 0);
  // 8 cores * 0.7 = 5.6 vCPU. At 0.30 per bootstrap that is 18 concurrent.
  assert.equal(gate.decide(10_000, { bootstrapping: 17, running: 0 }).admit, true);
  const refused = gate.decide(10_000, { bootstrapping: 18, running: 0 });
  assert.equal(refused.admit, false);
  assert.match(refused.reason, /cpu budget/);
});

test('steady viewers count against the budget too', () => {
  const gate = new AdmissionGate(8, noJitter, new CostModel(), () => 0);
  // The budget is 8 * 0.7 = 5.6 vCPU. 176 steady viewers at 0.03 is 5.28, which
  // still leaves room for one 0.30 bootstrap; 177 is 5.31, which does not.
  assert.equal(gate.decide(10_000, { bootstrapping: 0, running: 176 }).admit, true);
  assert.equal(gate.decide(10_000, { bootstrapping: 0, running: 177 }).admit, false);
});

test('flood mode disables both bounds', () => {
  const gate = new AdmissionGate(8, { ...noJitter, disabled: true }, new CostModel(), () => 0);
  gate.noteStart(1_000);
  assert.equal(gate.decide(1_000, { bootstrapping: 500, running: 500 }).admit, true);
});

test('measured cost replaces the prior once there is enough of it', () => {
  const costs = new CostModel();
  const gate = new AdmissionGate(8, noJitter, costs, () => 0);
  assert.equal(gate.budget().source, 'prior');
  assert.equal(gate.budget().bootstrapVcpu, 0.3);

  // An x86 hyperthread costing twice an M1 core-second should halve the fleet.
  for (let at = 0; at < 6; at += 1) {
    costs.observe('bootstrap', 0.36);
    costs.observe('steady', 0.06);
  }
  assert.equal(gate.budget().source, 'measured');
  assert.equal(gate.budget().bootstrapVcpu, 0.36);
  // 5.6 / 0.36 = 15.5, so 14 in flight plus one more fits and 15 does not.
  assert.equal(gate.decide(10_000, { bootstrapping: 14, running: 0 }).admit, true);
  assert.equal(gate.decide(10_000, { bootstrapping: 15, running: 0 }).admit, false);
});

test('a measured median ignores one slow outlier', () => {
  const costs = new CostModel();
  for (const vcpu of [0.1, 0.1, 0.1, 0.1, 0.1, 9.9]) {
    costs.observe('bootstrap', vcpu);
  }
  assert.equal(costs.measured('bootstrap'), 0.1);
});

test('partition splits by weight and never loses a viewer to rounding', () => {
  assert.deepEqual(partition(10, [1, 1]), [5, 5]);
  assert.deepEqual(partition(10, [1, 1, 1]), [4, 3, 3]);
  assert.equal(partition(200, [8, 4, 2]).reduce((sum, share) => sum + share, 0), 200);
  assert.deepEqual(partition(7, [3, 1]), [5, 2]);
  assert.deepEqual(partition(0, [1, 1]), [0, 0]);
});
