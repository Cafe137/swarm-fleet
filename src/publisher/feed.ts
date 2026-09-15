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
 *
 * Each update is written to the mirror gateways as well, through `SwarmWriter`.
 * The ordering above survives that, because a mirror write is started inside the
 * serialized chain: index n+1 is not dispatched anywhere until index n has
 * landed on the primary. A mirror write completing late can only duplicate a
 * chunk that is already in the network, never open a hole in front of one.
 *
 * Signing is deterministic (RFC 6979), so the same index and payload produce a
 * byte-identical single-owner chunk at every gateway — there is one feed, not
 * one per gateway.
 */

import { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';

import { SwarmWriter, UPLOAD_OPTIONS, ZERO_BATCH } from './swarm.js';

export class FeedPublisher {
  private nextIndex = 0;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly writer: SwarmWriter,
    private readonly topic: Topic,
    private readonly signer: PrivateKey,
    readonly topicRaw: string,
  ) {}

  /**
   * `topicRaw` is hashed the way bee-js `Topic.fromString` does it, which is the
   * same keccak256-of-the-string that the viewer's `normalize_feed_topic`
   * applies. Stream UUIDs therefore go in raw on both sides.
   */
  static create(writer: SwarmWriter, topicRaw: string, signer: PrivateKey): FeedPublisher {
    return new FeedPublisher(writer, Topic.fromString(topicRaw), signer, topicRaw);
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
      await this.writer.fanOut((bee) =>
        bee.feed.makeWriter(this.topic, this.signer).uploadPayload(ZERO_BATCH, payload, {
          ...UPLOAD_OPTIONS,
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
