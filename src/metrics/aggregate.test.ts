import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cohortKpis, ThroughputWindow } from './aggregate.js';
import { distribution } from './percentile.js';
import type { ViewerOutcome, ViewerRecord } from '../viewer/rollup.js';

function record(overrides: Partial<ViewerRecord> = {}): ViewerRecord {
  return {
    viewerId: 'host-0000',
    agent: 'host',
    owner: 'aabb',
    topic: 'ccdd',
    peerLimit: 200,
    live: true,
    startedAtMs: 0,
    outcome: 'completed' as ViewerOutcome,
    joined: true,
    segments: 50,
    bytes: 12_000_000,
    mediaS: 100,
    wallS: 100,
    stalls: 0,
    stalledS: 0,
    stallRatio: 0,
    fetchMs: distribution([500]),
    realtimeFactor: distribution([0.25]),
    bodyFailures: 0,
    secondStrikes: 0,
    skipped: 0,
    gapsPublisher: 0,
    gapsLocal: 0,
    reconstructProbes: 0,
    reconstructRuns: 0,
    finalized: true,
    events: 60,
    unknownEvents: 0,
    malformedLines: 0,
    errors: [],
    summarySeen: true,
    ...overrides,
  };
}

test('the headline is the share of viewers having a bad time, not a mean', () => {
  // Nineteen perfect viewers and one that lost half its media time. A mean
  // stall ratio would read 2.5% and look fine.
  const records = [
    ...Array.from({ length: 19 }, () => record()),
    record({ viewerId: 'host-0019', stalledS: 50, stallRatio: 0.5, stalls: 12 }),
  ];
  const kpis = cohortKpis(records, 20, 100);
  assert.equal(kpis.degradedViewers, 1);
  assert.equal(kpis.degradedFraction, 0.05);
  assert.equal(kpis.stallFreeFraction, 0.95);
  assert.equal(kpis.stallRatio.p50, 0);
});

test('requested and started are reported separately', () => {
  const kpis = cohortKpis([record(), record({ viewerId: 'b' })], 10, 100);
  assert.equal(kpis.viewers.requested, 10);
  assert.equal(kpis.viewers.started, 2);
});

test('join success only counts live viewers', () => {
  const kpis = cohortKpis(
    [
      record({ live: true, joined: true }),
      record({ viewerId: 'b', live: true, joined: false, outcome: 'never_joined' }),
      record({ viewerId: 'c', live: false, joined: false }),
    ],
    3,
    100,
  );
  assert.equal(kpis.joinSuccessRate, 0.5);
  assert.equal(kpis.viewers.failed, 1);
});

test('throughput and segment rate divide by the run window', () => {
  const kpis = cohortKpis([record(), record({ viewerId: 'b' })], 2, 100);
  assert.equal(kpis.bytes, 24_000_000);
  assert.equal(kpis.aggregateMbps, (24_000_000 * 8) / 100 / 1e6);
  assert.equal(kpis.segmentsPerSecond, 1);
});

test('body failure rate is failures over everything asked for', () => {
  const kpis = cohortKpis([record({ segments: 96, bodyFailures: 4 })], 1, 100);
  assert.equal(kpis.bodyFailureRate, 0.04);
});

test('distinct content ratio separates popularity from capacity', () => {
  const oneStream = cohortKpis(
    [record(), record({ viewerId: 'b' }), record({ viewerId: 'c' })],
    3,
    100,
  );
  assert.ok((oneStream.distinctContentRatio ?? 1) < 0.4);

  const allDifferent = cohortKpis(
    [
      record({ topic: 'one' }),
      record({ viewerId: 'b', topic: 'two' }),
      record({ viewerId: 'c', topic: 'three' }),
    ],
    3,
    100,
  );
  assert.equal(allDifferent.distinctContentRatio, 1);
});

test('the headline follows the trailing window, and the lifetime figure is kept', () => {
  // Every viewer stalled once early and has been clean for the last minute.
  // That is the shape of a cohort joining a live edge, and reporting it as
  // 100% degraded is what made a healthy hand-driven run look like a failure.
  const records = Array.from({ length: 10 }, (_, index) =>
    record({
      viewerId: `host-000${index}`,
      stalls: 1,
      stalledS: 1.5,
      stallRatio: 0.015,
      trailingStallRatio: 0,
      trailingMediaS: 60,
    }),
  );
  const kpis = cohortKpis(records, 10, 100);

  assert.equal(kpis.degradedFraction, 0);
  assert.equal(kpis.degradedFractionLifetime, 1);
  assert.equal(kpis.trailingStallRatio.p95, 0);
  // The stalls themselves are never hidden, whichever window is in front.
  assert.equal(kpis.stallsTotal, 10);
});

test('a viewer struggling right now is degraded however clean its history', () => {
  const records = [
    record({ stallRatio: 0.001, trailingStallRatio: 0.2, trailingMediaS: 60 }),
    record({ viewerId: 'host-0001', trailingStallRatio: 0, trailingMediaS: 60 }),
  ];
  const kpis = cohortKpis(records, 2, 100);
  assert.equal(kpis.degradedViewers, 1);
  assert.equal(kpis.degradedFraction, 0.5);
  assert.equal(kpis.degradedFractionLifetime, 0);
});

test('a viewer with a summary but no segment events keeps its lifetime ratio', () => {
  // Nothing to build a window from, so dropping it would shrink the
  // denominator and flatter the run.
  const kpis = cohortKpis([record({ stallRatio: 0.5, stalledS: 50 })], 1, 100);
  assert.equal(kpis.degradedFraction, 1);
  assert.equal(kpis.degradedViewers, 1);
});

test('a viewer stuck filling its buffer is degraded by definition', () => {
  const kpis = cohortKpis(
    [
      record({ mediaS: 4, segments: 2, stallRatio: 0, trailingStallRatio: 0, stuckPrerolling: true }),
      record({ viewerId: 'host-0001', trailingStallRatio: 0, trailingMediaS: 60 }),
    ],
    2,
    100,
  );
  assert.equal(kpis.stuckPrerolling, 1);
  assert.equal(kpis.degradedViewers, 1);
  assert.equal(kpis.degradedFraction, 0.5);
});

test('a cohort with nothing watched yet reports no data, not zero', () => {
  const kpis = cohortKpis([record({ segments: 0, mediaS: 0, stallRatio: undefined })], 1, 10);
  assert.equal(kpis.degradedFraction, undefined);
  assert.equal(kpis.stallFreeFraction, undefined);
});

test('the throughput window forgets what left the window', () => {
  const window = new ThroughputWindow(10_000);
  window.record(0, 1_000_000);
  window.record(1_000, 1_000_000);
  assert.equal(window.mbps(1_000), (2_000_000 * 8) / 10 / 1e6);
  // 20 s later both samples are outside a 10 s window.
  assert.equal(window.mbps(21_000), 0);
});
