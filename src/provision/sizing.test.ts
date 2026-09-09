import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TARGET_UTILISATION,
  capacityOf,
  choosePlan,
  demandFor,
  estimateCost,
  isDedicated,
  spreadRegions,
  viewerVcpu,
} from './sizing.js';
import { VultrPlan } from './vultr.js';

/** A plan shaped like the real catalogue, so the schema is exercised too. */
function plan(overrides: Partial<VultrPlan> & { id: string }): VultrPlan {
  return VultrPlan.parse({
    vcpu_count: 4,
    ram: 8192,
    disk: 180,
    bandwidth: 6144,
    monthly_cost: 80,
    hourly_cost: 0.11,
    type: 'voc',
    cpu_vendor: 'AMD',
    locations: ['fra', 'ams', 'lhr', 'ewr', 'sjc'],
    ...overrides,
  });
}

test('the cost model reproduces the run it was fitted to', () => {
  // runs/2026-09-09_17-21-15_cohort-200: 200 viewers, 128 peers, a 2.83 Mbps
  // stream, on six cores. The run pinned CPU at 97.3% and lost 95% of its
  // viewers, so the model has to say the box was over-committed — if it says
  // this fits, it would let the same mistake through again.
  const demand = demandFor({ viewers: 200, peers: 128, mediaMbps: 2.83 });

  // 8.7 vCPU asked of a machine with six.
  assert.ok(demand.vcpu > 8.5 && demand.vcpu < 8.9, `vcpu ${demand.vcpu}`);
  assert.ok(demand.cores > 12, `needed ${demand.cores} cores, had 6`);

  // Tracked RSS was 7637 MB across the 200.
  const rssMB = demand.memBytes / 1024 ** 2;
  assert.ok(rssMB > 7000 && rssMB < 8200, `rss ${rssMB} MB`);

  // Interface counters over the measured window: rx 457 Mbps, tx 120 Mbps.
  assert.ok(demand.rxMbps > 700, `rx ${demand.rxMbps} Mbps at full rate`);
  assert.ok(Math.abs(demand.txMbps - 119) < 10, `tx ${demand.txMbps} Mbps`);

  // 25,518 peer connections were held.
  assert.equal(demand.sockets, 25_600);
});

test('a six-core box holds far fewer than the 200 that run asked for', () => {
  const six = plan({ id: 'six', vcpu_count: 6, ram: 12_288 });
  const capacity = capacityOf(six, 128, 2.83);
  // Between 90 and 100: 6 x 0.7 / 0.0432.
  assert.ok(capacity.viewers >= 90 && capacity.viewers <= 100, `holds ${capacity.viewers}`);
  assert.equal(capacity.binding, 'cpu');
});

test('dropping the bitrate to 2 Mbps is a real density lever', () => {
  // The publisher default moved 2.83 -> 2.00 Mbps for exactly this reason.
  const at283 = viewerVcpu(2.83);
  const at200 = viewerVcpu(2.0);
  assert.ok(at200 < at283);
  const six = plan({ id: 'six', vcpu_count: 6, ram: 12_288 });
  assert.ok(capacityOf(six, 128, 2.0).viewers > capacityOf(six, 128, 2.83).viewers);
});

test('memory and ports bind before CPU on the wrong plan shapes', () => {
  // Plenty of cores, not enough RAM.
  const thin = plan({ id: 'thin', vcpu_count: 16, ram: 2048 });
  assert.equal(capacityOf(thin, 128, 2).binding, 'memory');

  // Plenty of both, but 55,296 ports at 512 peers each is 108 viewers.
  const wide = plan({ id: 'wide', vcpu_count: 64, ram: 262_144 });
  const ports = capacityOf(wide, 512, 2);
  assert.equal(ports.binding, 'ports');
  assert.equal(ports.viewers, 108);
});

test('the cheapest plan that fits wins, and dedicated is the default', () => {
  const plans = [
    plan({ id: 'shared-cheap', type: 'vhp', hourly_cost: 0.066 }),
    plan({ id: 'dedicated', type: 'voc', hourly_cost: 0.11 }),
    plan({ id: 'dedicated-big', type: 'voc', vcpu_count: 8, ram: 16_384, hourly_cost: 0.219 }),
    plan({ id: 'too-small', type: 'voc', vcpu_count: 1, ram: 1024, hourly_cost: 0.01 }),
  ];
  const filter = { viewersPerBox: 50, peers: 128, mediaMbps: 2 };

  assert.equal(choosePlan(plans, { ...filter, dedicatedOnly: true })?.plan.id, 'dedicated');
  assert.equal(choosePlan(plans, filter)?.plan.id, 'shared-cheap');

  // Nothing here can hold a thousand viewers, and saying so beats guessing.
  assert.equal(choosePlan(plans, { ...filter, viewersPerBox: 1000 }), undefined);
});

test('a plan missing from one region is not offered for a fleet spanning it', () => {
  const plans = [
    plan({ id: 'partial', hourly_cost: 0.05, locations: ['fra', 'ams'] }),
    plan({ id: 'everywhere', hourly_cost: 0.11 }),
  ];
  const filter = { viewersPerBox: 50, peers: 128, mediaMbps: 2 };
  assert.equal(choosePlan(plans, { ...filter, regions: ['fra', 'ams'] })?.plan.id, 'partial');
  assert.equal(choosePlan(plans, { ...filter, regions: ['fra', 'sjc'] })?.plan.id, 'everywhere');
});

test('`voc` is the only dedicated family, because the API will not say', () => {
  // Every plan reports vcpu_type "thread", so the family prefix is the signal.
  assert.equal(isDedicated(plan({ id: 'a', type: 'voc' })), true);
  for (const type of ['vc2', 'vhf', 'vhp', 'vx1', 'vcg']) {
    assert.equal(isDedicated(plan({ id: type, type })), false, type);
  }
});

test('an hour-long rental accrues an hour of transfer, not a month of it', () => {
  // The trap this exists to avoid: 6 TB/month reads as "free", but Vultr
  // accrues it hourly and never reconciles, so one hour earns 6144/672 = 9.1 GB.
  const box = plan({ id: 'box', bandwidth: 6144, hourly_cost: 0.11 });
  const cost = estimateCost(box, 5, 1, 13.5);

  assert.ok(Math.abs(cost.includedGb - 45.7) < 0.5, `accrued ${cost.includedGb} GB`);
  assert.equal(cost.egressGb, 67.5);
  assert.ok(Math.abs(cost.instanceUsd - 0.55) < 0.001);
  // 67.5 - 45.7 = 21.8 GB over, at $0.01.
  assert.ok(Math.abs(cost.egressUsd - 0.218) < 0.01, `egress $${cost.egressUsd}`);

  // A long run stops paying overage per hour only if usage drops below accrual.
  const under = estimateCost(box, 1, 10, 5);
  assert.equal(under.egressUsd, 0);
});

test('regions round-robin, so five boxes do not all land in one datacentre', () => {
  assert.deepEqual(spreadRegions(5, ['fra', 'ams', 'lhr']), ['fra', 'ams', 'lhr', 'fra', 'ams']);
  assert.deepEqual(spreadRegions(2, ['fra']), ['fra', 'fra']);
  assert.throws(() => spreadRegions(1, []), /no regions/);
});

test('headroom is left on purpose, and matches what admission uses', () => {
  // A plan sized to 100% would be a plan sized to the cliff cohort-200 fell off.
  assert.equal(TARGET_UTILISATION, 0.7);
  const box = plan({ id: 'box', vcpu_count: 4, ram: 8192 });
  const held = capacityOf(box, 128, 2).viewers;
  assert.ok(held * viewerVcpu(2) <= 4 * TARGET_UTILISATION);
});
