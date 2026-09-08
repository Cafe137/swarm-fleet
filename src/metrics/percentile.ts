/** Quantiles, means and a couple of shapes the reports need. */

/**
 * Linear-interpolated quantile of an unsorted sample. `q` is 0..1.
 *
 * Returns `undefined` for an empty sample rather than 0, because "no data" and
 * "zero" are different answers and a report that conflates them is misleading.
 */
export function quantile(values: readonly number[], q: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  if (lower === upper) {
    return low;
  }
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function max(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values);
}

export function min(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values);
}

export interface Distribution {
  count: number;
  p50?: number | undefined;
  p90?: number | undefined;
  p95?: number | undefined;
  p99?: number | undefined;
  mean?: number | undefined;
  max?: number | undefined;
}

export function distribution(values: readonly number[]): Distribution {
  return {
    count: values.length,
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    mean: mean(values),
    max: max(values),
  };
}
