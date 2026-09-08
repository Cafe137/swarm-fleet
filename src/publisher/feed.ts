/**
 * Sequence-feed writer for stream manifests.
 *
 * The publisher appends one feed update per manifest, so the feed index is a
 * manifest counter and **not** a segment counter. The viewer follows the feed by
 * probing `head + 1 .. head + 4`, tolerating exactly one missing index, so two
 * properties matter:
 *
 * - indices must be contiguous, and
 * - a lower index must never land after a higher one.
 *
 * Both are guaranteed here by allocating the index synchronously and serializing
 * the uploads behind a promise chain.
 */

import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';

import { withRetry, ZERO_BATCH } from './swarm.js';

export class FeedPublisher {
  private nextIndex = 0;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly bee: Bee,
    private readonly topic: Topic,
    private readonly signer: PrivateKey,
    readonly topicRaw: string,
  ) {}

  /**
   * `topicRaw` is hashed the way bee-js `Topic.fromString` does it, which is the
   * same keccak256-of-the-string that the viewer's `normalize_feed_topic`
   * applies. Stream UUIDs therefore go in raw on both sides.
   */
  static create(bee: Bee, topicRaw: string, signer: PrivateKey): FeedPublisher {
    return new FeedPublisher(bee, Topic.fromString(topicRaw), signer, topicRaw);
  }

  get owner(): string {
    return this.signer.publicKey().address().toHex();
  }

  get topicHex(): string {
    return this.topic.toHex();
  }

  /** Index the next write will claim. */
  get head(): number {
    return this.nextIndex;
  }

  /** Append a manifest as the next feed update, resolving to the index used. */
  write(payload: string): Promise<number> {
    const index = this.nextIndex;
    this.nextIndex += 1;
    const run = this.tail.then(async () => {
      const writer = this.bee.feed.makeWriter(this.topic, this.signer);
      await withRetry(() =>
        writer.uploadPayload(ZERO_BATCH, payload, {
          index: FeedIndex.fromBigInt(BigInt(index)),
        }),
      );
      return index;
    });
    // Keep the chain alive after a failure so later writes still serialize.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Wait for every queued write to settle. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
