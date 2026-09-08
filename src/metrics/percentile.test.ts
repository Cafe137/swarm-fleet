import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distribution, quantile } from './percentile.js';

test('an empty sample has no quantile, rather than a quantile of zero', () => {
  assert.equal(quantile([], 0.5), undefined);
  assert.equal(distribution([]).count, 0);
  assert.equal(distribution([]).p95, undefined);
});

test('quantiles interpolate and do not mutate the input', () => {
  const values = [4, 1, 3, 2];
  assert.equal(quantile(values, 0), 1);
  assert.equal(quantile(values, 1), 4);
  assert.equal(quantile(values, 0.5), 2.5);
  assert.deepEqual(values, [4, 1, 3, 2]);
});

test('a single value is every quantile of itself', () => {
  const only = distribution([7]);
  assert.equal(only.p50, 7);
  assert.equal(only.p99, 7);
  assert.equal(only.max, 7);
});
