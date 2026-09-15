/**
 * Swarm write path, aimed at public gateways rather than a local Bee node.
 *
 * `https://bzz.limo` accepts uploads with **no postage stamp** — it supplies its
 * own and ignores a `swarm-postage-batch-id` header entirely — so there is no
 * batch to buy, fund or keep topped up. bee-js still wants a `BatchId` argument,
 * so we hand it zeros. `https://api.gateway.ethswarm.org` behaves the same way,
 * which is what makes mirroring to it free.
 *
 * Two things here exist to get a segment into the network *sooner*, because a
 * live viewer at the edge is trying to retrieve a segment within seconds of its
 * upload and a chunk only the uploading node holds is a chunk nobody can find:
 *
 *   - **Every chunk is written to the mirrors as well as the primary**, in
 *     parallel, so time-to-findable is the faster gateway's rather than the
 *     primary's. `config.ts` has the measurements.
 *   - **Uploads are not deferred.** A deferred upload is stored on the gateway's
 *     own node and push-synced afterwards; `deferred: false` makes the gateway
 *     push to the neighbourhood before it answers. On bzz.limo that alone cut
 *     time-to-findable from ~2.2 s to ~1.0 s over three rounds (866/1242/920 ms
 *     against 2254/2135/2130 ms), at a small cost in upload latency.
 *
 * **A mirror must never be able to stall the stream.** The primary decides what
 * the reference is and when the publisher moves on; mirror writes are started at
 * the same moment and then left to finish on their own, are dropped when they
 * fall too far behind, and are abandoned entirely when the gateway stops
 * answering. A publisher that paused for a sick mirror would put a hole in the
 * playlist to protect an optimisation.
 */

import { BatchId, Bee } from '@ethersphere/bee-js';

export { DEFAULT_GATEWAY, DEFAULT_MIRRORS } from './config.js';
import { DEFAULT_GATEWAY, DEFAULT_MIRRORS } from './config.js';

/** Placeholder batch: the gateways ignore it. */
export const ZERO_BATCH = new BatchId('00'.repeat(32));

/**
 * `deferred: false` for the reason in the module header. `redundancyLevel: 1`
 * is what the publisher has always asked for and is unrelated.
 */
export const UPLOAD_OPTIONS = { redundancyLevel: 1, deferred: false } as const;

/**
 * Mirror writes still in flight, per mirror, before new ones are dropped.
 *
 * A mirror this far behind is not helping a viewer at the live edge — the
 * segment it is still uploading has already left the playlist window — so
 * queueing more of them only spends the publisher's bandwidth to arrive late.
 */
const MAX_IN_FLIGHT = 4;

/** Consecutive failures after which a mirror is abandoned for the run. */
const FAILURE_LIMIT = 5;

export function makeBee(gateway: string = DEFAULT_GATEWAY): Bee {
  return new Bee(gateway);
}

export interface MirrorReport {
  gateway: string;
  /** Writes the mirror accepted. */
  ok: number;
  /** Writes it refused or failed, after its own retries. */
  failed: number;
  /** Writes never attempted, because it was already `MAX_IN_FLIGHT` behind. */
  dropped: number;
  /** True once `FAILURE_LIMIT` consecutive failures retired it. */
  disabled: boolean;
}

interface Mirror extends MirrorReport {
  bee: Bee;
  inFlight: number;
  consecutiveFailures: number;
}

/** Anything bee-js returns from an upload. Compared to catch a divergent mirror. */
interface Referenced {
  reference: { toHex(): string };
}

export type WriterWarning = (message: string) => void;

/**
 * One primary gateway and any number of mirrors, written to together.
 *
 * `primary` is exposed because reads — the registry's current entries, a feed
 * reader — have exactly one right answer and no reason to ask twice.
 */
export class SwarmWriter {
  private readonly mirrors: Mirror[];
  private readonly pending = new Set<Promise<void>>();
  private warn: WriterWarning = () => undefined;

  private constructor(
    readonly gateway: string,
    readonly primary: Bee,
    mirrors: readonly string[],
  ) {
    this.mirrors = mirrors.map((url) => ({
      gateway: url,
      bee: makeBee(url),
      inFlight: 0,
      ok: 0,
      failed: 0,
      dropped: 0,
      disabled: false,
      consecutiveFailures: 0,
    }));
  }

  static open(
    gateway: string = DEFAULT_GATEWAY,
    mirrors: readonly string[] = DEFAULT_MIRRORS,
  ): SwarmWriter {
    // A mirror that is the primary under another spelling would double the
    // publisher's upload bandwidth to reach exactly the node it already has.
    const primary = normalize(gateway);
    const distinct = [...new Set(mirrors.map(normalize))].filter((url) => url !== primary);
    return new SwarmWriter(gateway, makeBee(gateway), distinct);
  }

  /** Where warnings about a misbehaving mirror go. */
  onWarning(warn: WriterWarning): void {
    this.warn = warn;
  }

  get mirrorGateways(): string[] {
    return this.mirrors.map((mirror) => mirror.gateway);
  }

  /**
   * Run `work` against the primary and every live mirror at once, resolving
   * with the primary's result as soon as it has one.
   *
   * The mirrors are started first so they are not waiting on the primary's
   * upload for the socket, and their promises are parked in `pending` for
   * `drain` rather than awaited here.
   */
  fanOut<T extends Referenced>(work: (bee: Bee) => Promise<T>): Promise<T> {
    const primary = withRetry(() => work(this.primary));
    for (const mirror of this.mirrors) {
      this.dispatch(mirror, work, primary);
    }
    return primary;
  }

  private dispatch<T extends Referenced>(
    mirror: Mirror,
    work: (bee: Bee) => Promise<T>,
    primary: Promise<T>,
  ): void {
    if (mirror.disabled) {
      return;
    }
    if (mirror.inFlight >= MAX_IN_FLIGHT) {
      mirror.dropped += 1;
      if (mirror.dropped === 1) {
        this.warn(
          `${mirror.gateway} fell ${MAX_IN_FLIGHT} writes behind and is being skipped while it ` +
            'catches up; the stream is unaffected, but it is propagating less of it',
        );
      }
      return;
    }

    mirror.inFlight += 1;
    // A mirror gets two attempts to the primary's four: it is best-effort, and
    // a long retry ladder only makes it later than the segment it is carrying.
    const task = withRetry(() => work(mirror.bee), 2, 200)
      .then(async (result) => {
        mirror.ok += 1;
        mirror.consecutiveFailures = 0;
        await this.agree(mirror, result, primary);
      })
      .catch((error: unknown) => {
        mirror.failed += 1;
        mirror.consecutiveFailures += 1;
        if (mirror.consecutiveFailures === FAILURE_LIMIT) {
          mirror.disabled = true;
          this.warn(
            `${mirror.gateway} failed ${FAILURE_LIMIT} writes in a row and will not be written ` +
              `to again this run: ${message(error)}`,
          );
        }
      })
      .finally(() => {
        mirror.inFlight -= 1;
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  /**
   * A mirror that returns a different reference is not carrying the same
   * content — a gateway encrypting, or applying its own redundancy, would do
   * this — so the chunks it propagates are ones no viewer will ask for. Worth a
   * warning and nothing more: the primary's reference is the one in the
   * playlist either way.
   */
  private async agree<T extends Referenced>(
    mirror: Mirror,
    result: T,
    primary: Promise<T>,
  ): Promise<void> {
    let expected: string;
    try {
      expected = (await primary).reference.toHex();
    } catch {
      return;
    }
    const actual = result.reference.toHex();
    if (actual !== expected && !mirror.disabled) {
      mirror.disabled = true;
      this.warn(
        `${mirror.gateway} stored ${actual} where ${this.gateway} stored ${expected}; it is ` +
          'propagating different chunks and is not helping this stream, so it was dropped',
      );
    }
  }

  /**
   * Wait for outstanding mirror writes, bounded.
   *
   * Called once, at the end, so the closing VOD manifest actually reaches the
   * mirrors — the update that a late viewer resolves the whole stream through.
   */
  async drain(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0 && Date.now() < deadline) {
      const timer = new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, deadline - Date.now())).unref?.(),
      );
      await Promise.race([Promise.allSettled([...this.pending]), timer]);
    }
  }

  report(): MirrorReport[] {
    return this.mirrors.map(({ gateway, ok, failed, dropped, disabled }) => ({
      gateway,
      ok,
      failed,
      dropped,
      disabled,
    }));
  }
}

/** Upload a segment body and return its Swarm reference as 64 hex chars. */
export async function uploadSegment(writer: SwarmWriter, data: Uint8Array): Promise<string> {
  const result = await writer.fanOut((bee) => bee.data.upload(ZERO_BATCH, data, UPLOAD_OPTIONS));
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

/** Compare gateways by what they address, not by how they were typed. */
function normalize(gateway: string): string {
  return gateway.trim().replace(/\/+$/, '').toLowerCase();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
