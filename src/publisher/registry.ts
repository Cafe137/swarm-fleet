/**
 * Optional stream catalog.
 *
 * A second feed listing the streams this publisher has started, so a stream can
 * be discovered rather than copy-pasted. Purely a convenience: `watch` takes
 * `(owner, topic)` directly and the viewer never reads a catalog.
 *
 * Payload is a bare JSON array, matching swarm-hls-stream's `StreamCatalog`. Note
 * that the registry deployed behind streamoverswarm.eth.limo wraps the same
 * entries in `{ entries: [...] }` — if anything ever has to read both, it needs
 * to accept either shape.
 */

import { Bee, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';

import { withRetry, ZERO_BATCH } from './swarm.js';

export type StreamState = 'live' | 'vod';

export interface RegistryEntry {
  title: string;
  owner: string;
  topic: string;
  state: StreamState;
  mediatype: 'video';
  timestamp: number;
  index?: number;
  duration?: number;
}

export class Registry {
  private constructor(
    private readonly bee: Bee,
    private readonly topic: Topic,
    private readonly signer: PrivateKey,
    private index: bigint | null,
    private entries: RegistryEntry[],
  ) {}

  static async open(bee: Bee, topicRaw: string, signer: PrivateKey): Promise<Registry> {
    const topic = Topic.fromString(topicRaw);
    const owner = signer.publicKey().address();
    try {
      const current = await bee.feed.makeReader(topic, owner).downloadPayload();
      const entries = current.payload.toJSON() as RegistryEntry[];
      return new Registry(bee, topic, signer, current.feedIndex.toBigInt(), entries);
    } catch {
      // 404 means the topic was never used, 503 that it has no entries yet.
      return new Registry(bee, topic, signer, null, []);
    }
  }

  /** Replace any entry with the same `(owner, topic)`, then append this one. */
  async upsert(entry: RegistryEntry): Promise<void> {
    this.entries = this.entries.filter(
      (existing) => existing.owner !== entry.owner || existing.topic !== entry.topic,
    );
    this.entries.push(entry);

    const next = this.index === null ? 0n : this.index + 1n;
    const writer = this.bee.feed.makeWriter(this.topic, this.signer);
    await withRetry(() =>
      writer.uploadPayload(ZERO_BATCH, JSON.stringify(this.entries), {
        index: FeedIndex.fromBigInt(next),
      }),
    );
    this.index = next;
  }
}
