/**
 * The publisher, as something a run can start and stop.
 *
 * A live fleet run needs a live stream, and before this the two were separate
 * projects: start `publisher/`, copy the owner and topic it printed, paste them
 * into a `--stream` flag, remember to kill it afterwards. Every one of those
 * steps is a way to measure the wrong thing — a stale topic, a stream that
 * ended twenty seconds into a five-minute run, a publisher left running on the
 * box under test.
 *
 * Two things here are not conveniences:
 *
 *   - **Viewers wait for a joinable window.** A viewer cannot join a live edge
 *     until the playlist carries `VIEWER_STARTUP_BUFFER_SECONDS` of contiguous
 *     segments behind it. Launched sooner, every viewer sits in `join` for up
 *     to 30 s and then reports a join latency that describes the publisher, not
 *     Swarm. So the run does not start viewers until the window exists.
 *   - **The publisher's cost is not the fleet's.** ffmpeg encoding 1120x700 at
 *     30fps is a real load — measured at 4.2 of 8 cores — and it lands on
 *     whichever machine the controller runs on. That is why it is reported as a
 *     caveat whenever an agent shares that machine, and why preflight's idle
 *     check will refuse such a run unless it is forced.
 */

import { randomUUID } from 'node:crypto';
import { publishLive, type PublishEvent, resolveSigner } from './publisher.js';
import type { MirrorReport } from './swarm.js';
import { type PublisherConfig, segmentsBeforeViewersCanJoin } from './config.js';
import type { StreamRef } from '../transport/protocol.js';

/**
 * What this configuration *will* publish, without publishing anything.
 *
 * The owner is the signer's address and the topic is a UUID, so both are known
 * before ffmpeg exists. That is what lets a settled run launch its viewers
 * first and start encoding only once they are all peered and parked: the
 * viewers need the `owner:topic` pair at launch, not a running stream.
 *
 * The returned config carries the topic explicitly, so the publisher that
 * eventually starts writes to the feed the viewers are already watching rather
 * than rolling a fresh UUID of its own.
 */
export function planStream(config: PublisherConfig): { stream: StreamRef; config: PublisherConfig } {
  const topic = config.topic ?? randomUUID();
  return {
    stream: { owner: resolveSigner().publicKey().address().toHex(), topic },
    config: { ...config, topic },
  };
}

export interface PublisherStats {
  owner: string;
  topic: string;
  gateway: string;
  /**
   * The gateways every chunk was also written to, and how they behaved.
   *
   * Kept in the run record because it changes how fast a segment becomes
   * findable, and therefore what the viewers' fetch times mean: a run where
   * every mirror was disabled is not comparable to one where they were not.
   */
  mirrors: MirrorReport[];
  segments: number;
  bytes: number;
  /** Last feed index written. The feed counts manifests, not segments. */
  feedIndex: number | undefined;
  meanUploadMs: number | undefined;
  meanManifestMs: number | undefined;
  mediaSeconds: number;
  finalized: boolean;
  warnings: string[];
  startedAt: string;
  endedAt?: string | undefined;
}

export interface PublisherHandle {
  /** What to point `--stream` at. Known as soon as `startPublisher` resolves. */
  readonly stream: StreamRef;
  /** Resolves when enough segments exist for a viewer to join the live edge. */
  joinable(timeoutMs: number): Promise<void>;
  stats(): PublisherStats;
  /** Wait for a bounded stream to reach its own end. */
  finished(): Promise<PublisherStats>;
  /** Finalize as VOD and wait for the closing feed update. */
  stop(timeoutMs?: number): Promise<PublisherStats>;
}

export type PublisherLog = (level: 'info' | 'warn', message: string) => void;

export async function startPublisher(
  config: PublisherConfig,
  log: PublisherLog = () => undefined,
): Promise<PublisherHandle> {
  const controller = new AbortController();
  const target = segmentsBeforeViewersCanJoin(config);

  let stats: PublisherStats | undefined;
  let uploadMsTotal = 0;
  let manifestMsTotal = 0;
  let resolveStarted: ((stream: StreamRef) => void) | undefined;
  let resolveJoinable: (() => void) | undefined;
  const started = new Promise<StreamRef>((resolve) => {
    resolveStarted = resolve;
  });
  const joinable = new Promise<void>((resolve) => {
    resolveJoinable = resolve;
  });

  const onEvent = (event: PublishEvent): void => {
    switch (event.kind) {
      case 'started':
        stats = {
          owner: event.owner,
          topic: event.topicRaw,
          gateway: event.gateway,
          mirrors: event.mirrors.map((gateway) => ({
            gateway,
            ok: 0,
            failed: 0,
            dropped: 0,
            disabled: false,
          })),
          segments: 0,
          bytes: 0,
          feedIndex: undefined,
          meanUploadMs: undefined,
          meanManifestMs: undefined,
          mediaSeconds: 0,
          finalized: false,
          warnings: [],
          startedAt: new Date().toISOString(),
        };
        log(
          'info',
          `stream ${event.owner}:${event.topicRaw} through ${event.gateway}` +
            (event.mirrors.length === 0
              ? ''
              : `, mirrored to ${event.mirrors.join(', ')}`),
        );
        resolveStarted?.({ owner: event.owner, topic: event.topicRaw });
        break;
      case 'segment': {
        if (stats === undefined) {
          break;
        }
        stats.segments += 1;
        stats.bytes += event.bytes;
        stats.mediaSeconds += event.duration;
        stats.feedIndex = event.feedIndex;
        uploadMsTotal += event.uploadMs;
        manifestMsTotal += event.manifestMs;
        stats.meanUploadMs = uploadMsTotal / stats.segments;
        stats.meanManifestMs = manifestMsTotal / stats.segments;
        if (stats.segments === target) {
          log(
            'info',
            `${target} segments published: ${(stats.mediaSeconds).toFixed(1)}s of playlist, ` +
              'enough runway for a viewer to join the live edge',
          );
          resolveJoinable?.();
        }
        break;
      }
      case 'finalized':
        if (stats !== undefined) {
          stats.finalized = true;
          stats.feedIndex = event.feedIndex;
        }
        break;
      case 'mirrors':
        if (stats !== undefined) {
          stats.mirrors = event.mirrors;
        }
        for (const mirror of event.mirrors) {
          log(
            'info',
            `mirror ${mirror.gateway}: ${mirror.ok} written` +
              (mirror.failed > 0 ? `, ${mirror.failed} failed` : '') +
              (mirror.dropped > 0 ? `, ${mirror.dropped} skipped` : '') +
              (mirror.disabled ? ', abandoned' : ''),
          );
        }
        break;
      case 'registered':
        log('info', `catalog entry written as ${event.state}`);
        break;
      case 'warning':
        stats?.warnings.push(event.message);
        log('warn', event.message);
        break;
    }
  };

  const running = publishLive(
    {
      source: config.source,
      segmentDuration: config.segmentDuration,
      size: config.size,
      bitrate: config.bitrate,
      gateway: config.gateway,
      mirrors: config.mirrors,
      windowSize: config.windowSize,
      registry: config.registry,
      ...(config.topic === undefined ? {} : { topicRaw: config.topic }),
      ...(config.durationS === undefined ? {} : { durationSeconds: config.durationS }),
      ...(config.dumpDir === undefined ? {} : { dumpDir: config.dumpDir }),
      ...(process.env['SWARM_FLEET_KEY'] === undefined
        ? {}
        : { privateKey: process.env['SWARM_FLEET_KEY'] }),
    },
    controller.signal,
    onEvent,
  );

  // A publisher that dies before it starts — no ffmpeg, an unreachable gateway
  // — must surface as that error, not as a wait for a stream that never comes.
  let failed: Error | undefined;
  const settled = running.catch((error: unknown) => {
    failed = error instanceof Error ? error : new Error(String(error));
    resolveStarted?.({ owner: '', topic: '' });
    resolveJoinable?.();
  });

  const stream = await started;
  if (failed !== undefined) {
    throw failed;
  }

  const current = (): PublisherStats => {
    if (stats === undefined) {
      throw new Error('the publisher reported no stream');
    }
    return {
      ...stats,
      mirrors: stats.mirrors.map((mirror) => ({ ...mirror })),
      warnings: [...stats.warnings],
    };
  };

  return {
    stream,
    async joinable(timeoutMs: number): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const outcome = await Promise.race([joinable.then(() => 'ready' as const), expired]);
        if (failed !== undefined) {
          throw failed;
        }
        if (outcome === 'timeout') {
          throw new Error(
            `the publisher produced ${current().segments} of the ${target} segments a viewer ` +
              `needs to join a live edge, in ${(timeoutMs / 1000).toFixed(0)}s. Encoding is ` +
              'probably not keeping up, or the gateway is refusing uploads.',
          );
        }
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
    stats: current,
    async finished(): Promise<PublisherStats> {
      await settled;
      if (failed !== undefined) {
        throw failed;
      }
      return { ...current(), endedAt: new Date().toISOString() };
    },
    async stop(timeoutMs = 60_000): Promise<PublisherStats> {
      controller.abort();
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([settled.then(() => 'done' as const), expired]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      const final = current();
      if (outcome === 'timeout') {
        final.warnings.push(
          `the publisher did not finish finalizing within ${(timeoutMs / 1000).toFixed(0)}s, ` +
            'so the stream may have no ENDLIST',
        );
      }
      return { ...final, endedAt: new Date().toISOString() };
    },
  };
}
