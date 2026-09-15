/**
 * The publisher's settings, kept apart from the publisher itself.
 *
 * `scenario.ts` has to validate these, and the agent's bundle has to *not*
 * carry an 11 MB Swarm SDK to do it, so the schema lives in a module with no
 * runtime dependencies and `control.ts` is imported dynamically by the two
 * commands that actually publish.
 */

import { z } from 'zod';

export const DEFAULT_GATEWAY = 'https://bzz.limo';

/**
 * Gateways the publisher writes every chunk to *as well as* the primary.
 *
 * Not redundancy — propagation. An upload is only useful to a viewer once some
 * node other than the uploader can serve it, and the two public gateways differ
 * sharply in how fast that happens. Measured 2026-09-15, uploading a unique
 * 500 KB blob (one 2 s segment at 2 Mbps) to one gateway and polling the other
 * until it served it, four rounds each way:
 *
 * | Uploaded to | Findable elsewhere after |
 * | --- | --- |
 * | `api.gateway.ethswarm.org` | 567, 586, 712, 804 ms |
 * | `bzz.limo` | 2192, 2258, 2583, 2826 ms |
 *
 * At a 2 s segment duration a bzz.limo-only segment is, on average, still
 * unfindable when the *next* one is published — which is the most likely
 * mechanism behind the 2-5% of segments a live viewer cannot retrieve at the
 * edge. Writing both places in parallel makes the time-to-findable the faster
 * of the two, and costs the publisher nothing it was not already spending on
 * ffmpeg.
 *
 * The same measurement is why `deferred: false` is set on every upload — see
 * `swarm.ts`.
 */
export const DEFAULT_MIRRORS: readonly string[] = ['https://api.gateway.ethswarm.org'];

/**
 * Seconds of contiguous playlist a viewer needs behind the live edge before it
 * can join at all — `HLS_LIVE_STARTUP_BUFFER_SECONDS` in the viewer
 * (`stream_hls.rs`). A fleet launched against a stream younger than this does
 * not fail fast: every viewer sits in `join`, waiting, for up to 30 s, and then
 * reports a join latency that is a fact about the publisher.
 */
export const VIEWER_STARTUP_BUFFER_SECONDS = 8;

export const PublisherConfig = z.object({
  /** `testsrc` for a synthetic pattern, otherwise a path to a media file. */
  source: z.string().default('testsrc'),
  segmentDuration: z.number().positive().default(2),
  /** Segments kept in the live manifest. */
  windowSize: z.number().int().positive().default(10),
  size: z.string().default('1120x700'),
  /**
   * Video bitrate, which is not the bitrate a viewer pays for.
   *
   * ffmpeg is handed this for `-b:v`; the AAC track adds a further 128k and
   * the MPEG-TS mux adds 3.8% on top of both — measured over the 2026-09-09
   * cohort-200 run, where `2600k` published 286,973,916 bytes of segments for
   * 810.5 s of media, a delivered 2832 kbps against 2728 kbps of elementary
   * streams. So the default is set from the delivered rate backwards:
   * (1800 + 128) x 1.038 = 2002 kbps, i.e. 2.0 Mbps on the wire and in the
   * viewer's CPU budget, which is the number density is sized against.
   */
  bitrate: z.string().default('1800k'),
  gateway: z.string().default(DEFAULT_GATEWAY),
  /**
   * Extra gateways every chunk is also written to, for propagation. Empty
   * disables mirroring; a mirror never gates the stream (see `swarm.ts`).
   */
  mirrors: z.array(z.string()).default([...DEFAULT_MIRRORS]),
  /** Stream topic; a fresh UUID when absent, as the deployed publishers use. */
  topic: z.string().optional(),
  registry: z.boolean().default(false),
  /** Total stream length. Absent means "until the run stops it". */
  durationS: z.number().positive().optional(),
  /** Segments to publish before viewers may start. Derived when absent. */
  readySegments: z.number().int().positive().optional(),
  /** Where to save every published manifest, for use as a test fixture. */
  dumpDir: z.string().optional(),
});
export type PublisherConfig = z.infer<typeof PublisherConfig>;

/**
 * How many segments must exist before a viewer can join at the live edge.
 *
 * The viewer needs `VIEWER_STARTUP_BUFFER_SECONDS` of contiguous non-gap
 * playlist *behind* the edge, and the newest segment is the edge itself, so the
 * runway needs one more segment than the buffer alone implies.
 */
export function segmentsBeforeViewersCanJoin(config: PublisherConfig): number {
  return (
    config.readySegments ??
    Math.ceil(VIEWER_STARTUP_BUFFER_SECONDS / config.segmentDuration) + 1
  );
}
