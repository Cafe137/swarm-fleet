/**
 * HLS segment source: ffmpeg produces segments, we hand them over as they land.
 *
 * ffmpeg's own playlist is the source of truth for durations — it knows the real
 * segment length, which drifts from the requested one because segments have to
 * break on keyframes. Polling that playlist is also how we learn a segment is
 * *complete*: the HLS muxer only appends an entry after closing the file.
 *
 * `-re` paces the input at wall-clock speed. That matters more than it looks: a
 * publisher that emits segments as fast as it can encode is a VOD publisher
 * wearing a live hat, and would never exercise a follower's polling at all.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const POLL_INTERVAL_MS = 200;
const FRAME_RATE = 30;

export interface RawSegment {
  readonly index: number;
  readonly duration: number;
  readonly path: string;
}

export interface SourceOptions {
  /** `testsrc` for a synthetic pattern, otherwise a path to a media file. */
  readonly source: string;
  readonly segmentDuration: number;
  readonly size: string;
  readonly bitrate: string;
  /** Total stream length in seconds; omit to run until stopped. */
  readonly durationSeconds?: number | undefined;
}

export async function* hlsSegments(
  options: SourceOptions,
  signal: AbortSignal,
): AsyncGenerator<RawSegment> {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-fleet-hls-'));
  const playlist = join(dir, 'stream.m3u8');
  const child = spawn('ffmpeg', ffmpegArgs(options, dir), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  let exitCode: number | null = null;
  child.on('exit', (code) => {
    exitCode = code ?? 0;
  });

  let stopping = false;
  let emitted = 0;
  try {
    for (;;) {
      const entries = await readPlaylist(playlist);
      while (emitted < entries.length) {
        const entry = entries[emitted];
        if (!entry) {
          break;
        }
        yield { index: emitted, duration: entry.duration, path: join(dir, entry.file) };
        emitted += 1;
      }

      if (exitCode !== null) {
        // ffmpeg is gone; one more read settles whether anything is left.
        if ((await readPlaylist(playlist)).length <= emitted) {
          if (exitCode !== 0 && !stopping && emitted === 0) {
            throw new Error(`ffmpeg exited ${exitCode}: ${lastLines(stderr)}`);
          }
          return;
        }
        continue;
      }

      // SIGINT rather than SIGKILL: it lets ffmpeg close and list the segment it
      // is midway through, so stopping does not throw away a partial segment.
      if (signal.aborted && !stopping) {
        stopping = true;
        child.kill('SIGINT');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    if (exitCode === null) {
      child.kill('SIGKILL');
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function ffmpegArgs(options: SourceOptions, dir: string): string[] {
  const args = ['-hide_banner', '-loglevel', 'warning'];

  if (options.source === 'testsrc') {
    // Swarm is content-addressed, so a deterministic source would republish
    // references that already exist and prove nothing. The seeded noise track
    // makes every run's bytes — and therefore every reference — new.
    const seed = Math.floor(Math.random() * 2_000_000_000);
    args.push('-re', '-f', 'lavfi', '-i', `testsrc2=size=${options.size}:rate=${FRAME_RATE}`);
    args.push('-re', '-f', 'lavfi', '-i', `anoisesrc=r=48000:a=0.3:seed=${seed}`);
    args.push('-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-re', '-i', options.source);
    args.push('-map', '0:v:0', '-map', '0:a:0?');
  }

  if (options.durationSeconds !== undefined) {
    args.push('-t', String(options.durationSeconds));
  }

  // Keyframe every segment, so segments are independently decodable.
  const gop = String(Math.max(1, Math.round(options.segmentDuration * FRAME_RATE)));
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', options.bitrate,
    '-pix_fmt', 'yuv420p', '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-f', 'hls',
    '-hls_time', String(options.segmentDuration),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', join(dir, 'seg%06d.ts'),
    join(dir, 'stream.m3u8'),
  );
  return args;
}

async function readPlaylist(path: string): Promise<{ duration: number; file: string }[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  // A half-written playlist simply yields fewer complete pairs, which is safe:
  // the missing ones turn up on the next poll.
  const lines = text.split('\n');
  const entries: { duration: number; file: string }[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const matched = /^#EXTINF:([0-9.]+),/.exec(lines[at]?.trim() ?? '');
    if (!matched?.[1]) {
      continue;
    }
    const file = lines[at + 1]?.trim();
    if (!file || file.startsWith('#')) {
      continue;
    }
    entries.push({ duration: Number(matched[1]), file });
  }
  return entries;
}

function lastLines(text: string, count = 3): string {
  return text.trim().split('\n').slice(-count).join(' | ');
}
