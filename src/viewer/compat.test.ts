/**
 * Format compatibility with the real binary.
 *
 * The fixtures are captured `--metrics json` output from actual mainnet runs of
 * `weeb-3-rs-hls`, the way `weeb-3/tests/fixtures/` holds real publisher
 * manifests. They exist so the contract cannot drift on either side without a
 * test going red: the runner's whole claim is that it never parses text, which
 * is only true while these two agree.
 *
 * Recapture with:
 *   weeb-3-rs-hls watch <owner> <topic> --metrics json --segments 4 2>/dev/null
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseViewerEvent } from './contract.js';
import { ViewerRollup } from './rollup.js';

const fixtures = path.join(fileURLToPath(new URL('../../fixtures/', import.meta.url)));

async function lines(name: string): Promise<string[]> {
  const text = await readFile(path.join(fixtures, name), 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0);
}

function fold(name: string, raw: readonly string[], live: boolean): ViewerRollup {
  const rollup = new ViewerRollup({
    viewerId: name,
    agent: 'fixture',
    owner: 'unused',
    topic: 'unused',
    peerLimit: 200,
    live,
    startedAtMs: 0,
  });
  for (const line of raw) {
    const parsed = parseViewerEvent(line);
    assert.equal(parsed.ok, true, `unparseable fixture line: ${line}`);
    if (!parsed.ok) {
      continue;
    }
    assert.equal(parsed.known, true, `unknown ev in fixture: ${line}`);
    rollup.apply(parsed.event);
  }
  return rollup;
}

test('a real VOD watch parses into the KPIs the report needs', async () => {
  const raw = await lines('mainnet-vod-4-segments.ndjson');
  const rollup = fold('vod', raw, false);
  rollup.noteExit({ code: 0, signal: null, requested: false }, 10_000);
  const record = rollup.finish();

  // Straight off a real mainnet run: 4 segments, 2.6 MB, 200 peers.
  assert.equal(record.segments, 4);
  assert.equal(record.bytes, 2_625_608);
  assert.equal(record.mediaS, 8);
  assert.equal(record.stalls, 0);
  assert.equal(record.stallRatio, 0);
  assert.equal(record.peersMax, 200);
  assert.equal(record.joined, true);
  assert.equal(record.joinMs, 7542);
  assert.equal(record.summarySeen, true);
  assert.equal(record.outcome, 'completed');
  assert.equal(record.malformedLines, 0);
  assert.equal(record.unknownEvents, 0);

  // ~335 ms to fetch a 2 s segment is a realtime factor near 0.17: six times
  // faster than playback, which is what CLAUDE.md measured.
  assert.ok((record.realtimeFactor.p50 ?? 1) < 0.2);
  assert.ok((record.fetchMs.p50 ?? 0) > 300 && (record.fetchMs.p50 ?? 0) < 400);
});

test('a peer-only run parses, and reports no playback', async () => {
  const raw = await lines('mainnet-peer-only.ndjson');
  const rollup = fold('peer', raw, false);
  rollup.noteExit({ code: 0, signal: null, requested: false }, 11_000);
  const record = rollup.finish();

  assert.equal(record.segments, 0);
  assert.equal(record.bytes, 0);
  // No media watched means no stall ratio, rather than a stall ratio of zero.
  assert.equal(record.stallRatio, undefined);
  assert.ok((record.peersMax ?? 0) >= 25);
  assert.equal(record.summarySeen, true);
});

test('the binary honours --peers, which is the fleet density lever', async () => {
  const raw = await lines('mainnet-peer-only.ndjson');
  const start = parseViewerEvent(raw[0] as string);
  assert.equal(start.ok, true);
  if (!start.ok) {
    return;
  }
  assert.equal(start.event.ev, 'start');
  assert.equal(start.event['peer_limit'], 30);
  assert.equal(start.event['mode'], 'peer');
  // Absent, not null: the emitter drops empty fields so "string or missing"
  // validation holds.
  assert.equal('owner' in start.event, false);
});
