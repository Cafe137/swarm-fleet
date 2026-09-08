/**
 * HLS manifest construction, in the exact shape the native viewer parses.
 *
 * Ported from swarm-hls-stream's `ManifestManager`. The two properties the Rust
 * side depends on:
 *
 * - A segment URI's **last path component is the Swarm reference**. The viewer
 *   keeps only that and retrieves the body from peers, never from the gateway,
 *   so the base URL is cosmetic — but it has to be there, because that is what
 *   the deployed publishers emit.
 * - Consecutive live manifests must overlap identically. The viewer's
 *   `merge_extension` rejects a candidate whose overlapping segments differ, so
 *   the sliding window may only ever shed from the front and grow at the back.
 */

export interface SegmentEntry {
  /** Media sequence number, as numbered by the segmenter. */
  readonly index: number;
  /** Playback duration in seconds. */
  readonly duration: number;
  /** Swarm reference, 64 hex chars, no `0x`. */
  readonly ref: string;
}

export interface ManifestOptions {
  /** Prefix for segment URIs. Cosmetic to the viewer; kept for parity. */
  readonly baseUrl: string;
  /** Segments kept in a live manifest. Upstream default is 10. */
  readonly windowSize: number;
}

const HEADERS = ['#EXTM3U', '#EXT-X-VERSION:3'] as const;

export class ManifestManager {
  private readonly segments: SegmentEntry[] = [];
  private targetDuration = 0;

  constructor(private readonly options: ManifestOptions) {}

  addSegment(entry: SegmentEntry): void {
    this.segments.push(entry);
    this.segments.sort((a, b) => a.index - b.index);
    this.targetDuration = Math.max(this.targetDuration, Math.ceil(entry.duration));
  }

  get count(): number {
    return this.segments.length;
  }

  totalDuration(): number {
    return this.segments.reduce((sum, segment) => sum + segment.duration, 0);
  }

  /**
   * The rolling live manifest: the last `windowSize` segments, with
   * `#EXT-X-MEDIA-SEQUENCE` naming the first of them. No `#EXT-X-ENDLIST`, which
   * is what makes the viewer report the playlist as unfinalized.
   */
  buildLive(): string | null {
    if (this.segments.length === 0) {
      return null;
    }
    const window = this.segments.slice(-this.options.windowSize);
    const first = window[0];
    if (!first) {
      return null;
    }
    return this.render([`#EXT-X-MEDIA-SEQUENCE:${first.index}`], window, false);
  }

  /**
   * The closing manifest: every segment from the start, plus `#EXT-X-ENDLIST`.
   * This is the update that turns a live stream into a VOD.
   */
  buildVod(): string | null {
    if (this.segments.length === 0) {
      return null;
    }
    return this.render(
      ['#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-MEDIA-SEQUENCE:${this.segments[0]?.index ?? 0}`],
      this.segments,
      true,
    );
  }

  private render(tags: string[], segments: readonly SegmentEntry[], endlist: boolean): string {
    const lines = [
      ...HEADERS,
      `#EXT-X-TARGETDURATION:${this.targetDuration}`,
      ...tags,
      '',
    ];
    for (const segment of segments) {
      lines.push(`#EXTINF:${segment.duration.toFixed(3)},`);
      lines.push(this.segmentUri(segment.ref));
    }
    if (endlist) {
      lines.push('#EXT-X-ENDLIST');
    }
    return `${lines.join('\n')}\n`;
  }

  private segmentUri(ref: string): string {
    return this.options.baseUrl ? `${this.options.baseUrl}/${ref}` : ref;
  }
}
