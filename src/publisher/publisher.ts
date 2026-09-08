/**
 * The live publisher: ffmpeg segments in, Swarm feed updates out.
 *
 * One feed update per manifest, so the feed index counts manifests and not
 * segments. The viewer follows the feed forward from its head, which is why the
 * `FeedPublisher` serializes writes — a lower index landing after a higher one
 * would stall the follower.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PrivateKey } from '@ethersphere/bee-js';

import { FeedPublisher } from './feed.js';
import { ManifestManager } from './manifest.js';
import { Registry } from './registry.js';
import { hlsSegments, type SourceOptions } from './source.js';
import { DEFAULT_GATEWAY, makeBee, uploadSegment } from './swarm.js';

/**
 * Phrase behind the default dev key, so `owner` is stable across runs, and the
 * topic the stream catalog lives under.
 *
 * These two still say `everstream` after the rename, and deliberately. They are
 * not names, they are Swarm identities: the phrase derives the private key whose
 * address every dev stream is published under, and the topic is where the
 * catalog of those streams already sits. Renaming them would move the owner
 * address and abandon the catalog, so every `owner:topic` pair recorded in the
 * docs, in a run directory or in a test fixture would stop resolving. Change
 * them only as a deliberate migration to a new dev identity, never as part of a
 * rename.
 */
const DEV_KEY_PHRASE = 'everstream-dev-publisher-v1';
const REGISTRY_TOPIC = 'everstream-streams';

export interface PublishOptions extends SourceOptions {
  readonly gateway: string;
  readonly windowSize: number;
  /** Stream topic. A fresh UUID by default, as the deployed publishers use. */
  readonly topicRaw?: string | undefined;
  /** Private key hex; falls back to the documented dev key. */
  readonly privateKey?: string | undefined;
  readonly registry: boolean;
  /** Write every manifest here as it is published, for use as a test fixture. */
  readonly dumpDir?: string | undefined;
}

export type PublishEvent =
  | { kind: 'started'; owner: string; topicRaw: string; topicHex: string; gateway: string }
  | {
      kind: 'segment';
      segment: number;
      feedIndex: number;
      bytes: number;
      duration: number;
      ref: string;
      uploadMs: number;
      manifestMs: number;
    }
  | { kind: 'registered'; state: 'live' | 'vod' }
  | { kind: 'finalized'; feedIndex: number; segments: number; duration: number }
  | { kind: 'warning'; message: string };

/**
 * The default key is derived from a fixed phrase rather than hardcoded, so it is
 * reproducible without a magic constant sitting in the tree. It is a *dev* key:
 * anyone reading this file can write to the same feeds.
 */
export function resolveSigner(privateKey?: string): PrivateKey {
  if (privateKey) {
    return new PrivateKey(privateKey.replace(/^0x/, ''));
  }
  return new PrivateKey(createHash('sha256').update(DEV_KEY_PHRASE).digest());
}

export async function publishLive(
  options: PublishOptions,
  signal: AbortSignal,
  report: (event: PublishEvent) => void,
): Promise<void> {
  const bee = makeBee(options.gateway);
  const signer = resolveSigner(options.privateKey);
  const feed = FeedPublisher.create(bee, options.topicRaw ?? randomUUID(), signer);
  const manifest = new ManifestManager({
    baseUrl: `${options.gateway.replace(/\/$/, '')}/bytes`,
    windowSize: options.windowSize,
  });

  report({
    kind: 'started',
    owner: feed.owner,
    topicRaw: feed.topicRaw,
    topicHex: feed.topicHex,
    gateway: options.gateway,
  });

  const registry = options.registry
    ? await Registry.open(bee, REGISTRY_TOPIC, signer)
    : null;
  let announced = false;

  if (options.dumpDir !== undefined) {
    await mkdir(options.dumpDir, { recursive: true });
  }
  const dump = async (index: number, body: string): Promise<void> => {
    if (options.dumpDir !== undefined) {
      await writeFile(join(options.dumpDir, `${String(index).padStart(4, '0')}.m3u8`), body);
    }
  };

  for await (const raw of hlsSegments(options, signal)) {
    const body = await readFile(raw.path);
    const uploadStarted = Date.now();
    const ref = await uploadSegment(bee, body);
    const uploadMs = Date.now() - uploadStarted;

    manifest.addSegment({ index: raw.index, duration: raw.duration, ref });
    const live = manifest.buildLive();
    if (!live) {
      continue;
    }
    const manifestStarted = Date.now();
    const feedIndex = await feed.write(live);
    await dump(feedIndex, live);
    report({
      kind: 'segment',
      segment: raw.index,
      feedIndex,
      bytes: body.byteLength,
      duration: raw.duration,
      ref,
      uploadMs,
      manifestMs: Date.now() - manifestStarted,
    });

    // Announce only once there is something watchable, as upstream does.
    if (registry && !announced) {
      announced = true;
      await registry.upsert(entryFor(feed, 'live'));
      report({ kind: 'registered', state: 'live' });
    }
  }

  // The closing update: the full playlist plus #EXT-X-ENDLIST, which is what
  // turns the stream into a VOD for anyone who resolves the feed afterwards.
  const vod = manifest.buildVod();
  if (!vod) {
    report({ kind: 'warning', message: 'no segments were produced; nothing to finalize' });
    return;
  }
  const feedIndex = await feed.write(vod);
  await dump(feedIndex, vod);
  await feed.drain();
  report({
    kind: 'finalized',
    feedIndex,
    segments: manifest.count,
    duration: manifest.totalDuration(),
  });

  if (registry) {
    await registry.upsert({
      ...entryFor(feed, 'vod'),
      index: feedIndex,
      duration: manifest.totalDuration(),
    });
    report({ kind: 'registered', state: 'vod' });
  }
}

function entryFor(feed: FeedPublisher, state: 'live' | 'vod') {
  return {
    title: new Date().toISOString().slice(0, 19).replace('T', ' '),
    owner: feed.owner,
    topic: feed.topicRaw,
    state,
    mediatype: 'video' as const,
    timestamp: Date.now(),
  };
}

export { DEFAULT_GATEWAY };
