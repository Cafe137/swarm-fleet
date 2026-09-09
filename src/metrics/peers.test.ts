import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describePeerShortfall,
  PEER_JOIN_ALLOWANCE_MS,
  type PeerAttainment,
  summarisePeerAttainment,
} from './peers.js';

function viewer(overrides: Partial<PeerAttainment> = {}): PeerAttainment {
  return {
    target: 200,
    peak: 200,
    last: 200,
    lifetimeMs: 120_000,
    crashed: false,
    ...overrides,
  };
}

test('a viewer at its full footprint is holding', () => {
  const summary = summarisePeerAttainment([viewer(), viewer()]);
  assert.equal(summary.judged, 2);
  assert.equal(summary.holding, 2);
  assert.equal(summary.shortfallFraction, 0);
  assert.equal(summary.attainedFraction, 1);
});

test('peers churn, so just under the target is still holding', () => {
  const summary = summarisePeerAttainment([viewer({ last: 199, peak: 200 })]);
  assert.equal(summary.holding, 1);
  assert.equal(summary.evicted, 0);
});

test('reached the target then lost it is evicted, not starved', () => {
  // The NAT shape: every viewer got its peers, then had them taken back.
  const summary = summarisePeerAttainment([viewer({ peak: 200, last: 58 })]);
  assert.equal(summary.holding, 0);
  assert.equal(summary.evicted, 1);
  assert.equal(summary.starved, 0);
});

test('never reached the target is starved, not evicted', () => {
  const summary = summarisePeerAttainment([viewer({ peak: 16, last: 8 })]);
  assert.equal(summary.starved, 1);
  assert.equal(summary.evicted, 0);
});

test('a viewer still mid-join is skipped, because a low count is expected there', () => {
  const summary = summarisePeerAttainment([
    viewer({ lifetimeMs: PEER_JOIN_ALLOWANCE_MS - 1, peak: 12, last: 12 }),
  ]);
  assert.equal(summary.judged, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.shortfallFraction, undefined);
});

test('a crashed viewer says nothing about peer capacity', () => {
  const summary = summarisePeerAttainment([viewer({ crashed: true, last: 0, peak: 0 })]);
  assert.equal(summary.judged, 0);
  assert.equal(summary.skipped, 1);
});

test('attained fraction is peers held over peers asked for', () => {
  const summary = summarisePeerAttainment([viewer({ last: 100 }), viewer({ last: 200 })]);
  assert.equal(summary.peersHeld, 300);
  assert.equal(summary.peersWanted, 400);
  assert.equal(summary.attainedFraction, 0.75);
});

test('the shortfall line points at a NAT when eviction dominates', () => {
  const summary = summarisePeerAttainment([
    viewer({ peak: 200, last: 30 }),
    viewer({ peak: 200, last: 40 }),
  ]);
  const detail = describePeerShortfall(summary);
  assert.match(detail, /reached the target then lost it/);
  assert.match(detail, /NAT|conntrack/);
});

test('the shortfall line points elsewhere when viewers never got peers', () => {
  const summary = summarisePeerAttainment([viewer({ peak: 0, last: 0 })]);
  assert.match(describePeerShortfall(summary), /never reached it at all/);
});

/**
 * The measurement this exists for: one rented box, 80 viewers at 200 peers,
 * where the fleet held roughly half the connections it asked for while CPU sat
 * at 3.27 of 122 cores. Numbers from that run, rounded to its reported means.
 */
test('the 80-viewer NAT collapse reads as a shortfall, not a healthy fleet', () => {
  const viewers = Array.from({ length: 80 }, () => viewer({ peak: 200, last: 102 }));
  const summary = summarisePeerAttainment(viewers);
  assert.equal(summary.holding, 0);
  assert.equal(summary.evicted, 80);
  assert.equal(summary.shortfallFraction, 1);
  assert.ok((summary.attainedFraction ?? 1) < 0.55);
});

test('a healthy 64-viewer cohort on the same box reads clean', () => {
  const viewers = Array.from({ length: 64 }, () => viewer());
  const summary = summarisePeerAttainment(viewers);
  assert.equal(summary.holding, 64);
  assert.equal(summary.shortfallFraction, 0);
});

test('a viewer that reached its target is judged at once, without waiting out the allowance', () => {
  // Eviction is visible immediately: it already had its peers, so a low count
  // now is a loss, not a slow start. This is also the only way the mock viewer,
  // which compresses time and exits in under 10 s, can exercise any of this.
  const summary = summarisePeerAttainment([
    viewer({ lifetimeMs: 9_700, peak: 200, last: 20 }),
  ]);
  assert.equal(summary.judged, 1);
  assert.equal(summary.evicted, 1);
});

test('a short-lived viewer that reached its footprint and kept it is holding', () => {
  const summary = summarisePeerAttainment([viewer({ lifetimeMs: 9_700, peak: 120, last: 120, target: 120 })]);
  assert.equal(summary.judged, 1);
  assert.equal(summary.holding, 1);
});
