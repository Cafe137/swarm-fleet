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
  bitrate: z.string().default('2600k'),
  gateway: z.string().default(DEFAULT_GATEWAY),
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
