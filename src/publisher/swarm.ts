/**
 * Swarm write path, aimed at a public gateway rather than a local Bee node.
 *
 * `https://bzz.limo` accepts uploads with **no postage stamp** — it supplies its
 * own and ignores a `swarm-postage-batch-id` header entirely — so there is no
 * batch to buy, fund or keep topped up. bee-js still wants a `BatchId` argument,
 * so we hand it zeros.
 */

import { BatchId, Bee } from '@ethersphere/bee-js';

export { DEFAULT_GATEWAY } from './config.js';
import { DEFAULT_GATEWAY } from './config.js';

/** Placeholder batch: the gateway ignores it. */
export const ZERO_BATCH = new BatchId('00'.repeat(32));

export function makeBee(gateway: string = DEFAULT_GATEWAY): Bee {
  return new Bee(gateway);
}

/** Upload a segment body and return its Swarm reference as 64 hex chars. */
export async function uploadSegment(bee: Bee, data: Uint8Array): Promise<string> {
  const result = await withRetry(() =>
    bee.data.upload(ZERO_BATCH, data, { redundancyLevel: 1 }),
  );
  return result.reference.toHex();
}

/**
 * Retry with linear backoff.
 *
 * A live publisher cannot pause: a segment that fails to upload is a hole in the
 * stream, and the viewer's window slides past it in seconds. Better to spend a
 * second retrying than to leave a gap.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  attempts = 4,
  delayMs = 250,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw last;
}
