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

import { FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';

import { SwarmWriter, UPLOAD_OPTIONS, ZERO_BATCH } from './swarm.js';

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
    private readonly writer: SwarmWriter,
    private readonly topic: Topic,
    private readonly signer: PrivateKey,
    private index: bigint | null,
    private entries: RegistryEntry[],
  ) {}

  static async open(writer: SwarmWriter, topicRaw: string, signer: PrivateKey): Promise<Registry> {
    const topic = Topic.fromString(topicRaw);
    const owner = signer.publicKey().address();
    try {
      // Read from the primary only: the current entries have one right answer,
      // and asking every mirror for it would just be slower.
      const current = await writer.primary.feed.makeReader(topic, owner).downloadPayload();
      const entries = current.payload.toJSON() as RegistryEntry[];
      return new Registry(writer, topic, signer, current.feedIndex.toBigInt(), entries);
    } catch {
      // 404 means the topic was never used, 503 that it has no entries yet.
      return new Registry(writer, topic, signer, null, []);
    }
  }

  /** Replace any entry with the same `(owner, topic)`, then append this one. */
  async upsert(entry: RegistryEntry): Promise<void> {
    this.entries = this.entries.filter(
      (existing) => existing.owner !== entry.owner || existing.topic !== entry.topic,
    );
    this.entries.push(entry);

    const next = this.index === null ? 0n : this.index + 1n;
    const payload = JSON.stringify(this.entries);
    await this.writer.fanOut((bee) =>
      bee.feed.makeWriter(this.topic, this.signer).uploadPayload(ZERO_BATCH, payload, {
        ...UPLOAD_OPTIONS,
        index: FeedIndex.fromBigInt(next),
      }),
    );
    this.index = next;
  }
}
