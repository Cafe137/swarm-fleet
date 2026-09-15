import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseViewerEvent } from './contract.js';
import { DEGRADED_STALL_RATIO, TRAILING_STALL_WINDOW_S, ViewerRollup } from './rollup.js';

const identity = {
  viewerId: 'host-0000',
  agent: 'host',
  owner: 'aabb',
  topic: 'ccdd',
  peerLimit: 200,
  live: true,
  startedAtMs: 1_000,
};

function fold(lines: readonly string[]): ViewerRollup {
  const rollup = new ViewerRollup(identity);
  for (const line of lines) {
    const parsed = parseViewerEvent(line);
    if (parsed.ok) {
      rollup.apply(parsed.event);
    } else {
      rollup.noteMalformed();
    }
  }
  return rollup;
}

test('stall ratio is stalled time over media time', () => {
  const record = fold([
    '{"t":100,"ev":"joined","join_ms":100,"feed_index":10,"start_sequence":1,"runway_s":8,"window":10}',
    '{"t":600,"ev":"segment","sequence":1,"bytes":1000,"fetch_ms":500,"segment_s":2,"buffered_s":2}',
    '{"t":3600,"ev":"segment","sequence":2,"bytes":1000,"fetch_ms":3000,"segment_s":2,"buffered_s":0.5,"stalled":true,"stall_s":1}',
  ]).finish();

  assert.equal(record.segments, 2);
  assert.equal(record.mediaS, 4);
  assert.equal(record.stalls, 1);
  assert.equal(record.stalledS, 1);
  assert.equal(record.stallRatio, 0.25);
  assert.equal(record.longestStallS, 1);
});

test('the trailing ratio lets a viewer stop being degraded once it recovers', () => {
  // One 3 s stall, then 60 s of clean media at 2 s a segment. Over the whole
  // run that is still 4.6% and degraded; over the last minute it is nothing.
  const lines = [
    '{"t":600,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":500,"segment_s":2,"buffered_s":2}',
    '{"t":4000,"ev":"segment","sequence":2,"bytes":1,"fetch_ms":3400,"segment_s":2,"buffered_s":0.1,"stalled":true,"stall_s":3}',
  ];
  for (let index = 0; index < 31; index += 1) {
    lines.push(
      `{"t":${5000 + index * 2000},"ev":"segment","sequence":${3 + index},"bytes":1,"fetch_ms":500,"segment_s":2,"buffered_s":8}`,
    );
  }
  const record = fold(lines).finish();

  assert.equal(record.stalledS, 3);
  assert.ok((record.stallRatio ?? 0) > DEGRADED_STALL_RATIO, 'lifetime ratio still counts it');
  assert.equal(record.trailingStallRatio, 0);
  assert.ok((record.trailingMediaS ?? 0) <= TRAILING_STALL_WINDOW_S + 2);
});

test('the trailing window is trimmed by media seconds, not by segment count', () => {
  // 10 s segments: six of them fill the window, so the seventh pushes the
  // stalled first one out. Counting segments instead would keep it.
  const lines = [
    '{"t":1000,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":900,"segment_s":10,"buffered_s":1,"stalled":true,"stall_s":5}',
  ];
  for (let index = 0; index < 6; index += 1) {
    lines.push(
      `{"t":${11000 + index * 10000},"ev":"segment","sequence":${2 + index},"bytes":1,"fetch_ms":900,"segment_s":10,"buffered_s":9}`,
    );
  }
  const record = fold(lines).finish();

  assert.equal(record.stalls, 1);
  assert.equal(record.trailingStallRatio, 0);
});

test('a viewer still inside the window is judged on everything it has', () => {
  const record = fold([
    '{"t":600,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":500,"segment_s":2,"buffered_s":2}',
    '{"t":4000,"ev":"segment","sequence":2,"bytes":1,"fetch_ms":3400,"segment_s":2,"buffered_s":0.1,"stalled":true,"stall_s":1}',
  ]).finish();

  assert.equal(record.trailingMediaS, 4);
  assert.equal(record.trailingStallRatio, 0.25);
  assert.equal(record.stallRatio, 0.25);
});

test('a viewer that never filled its buffer is flagged, not scored as clean', () => {
  // Two segments in a minute: it never had a playhead, so it never stalled —
  // which is the most misleading zero in the report if it is left unqualified.
  const record = fold([
    '{"t":30000,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":29000,"segment_s":2,"buffered_s":2,"playing":false}',
    '{"t":64000,"ev":"segment","sequence":2,"bytes":1,"fetch_ms":34000,"segment_s":2,"buffered_s":4,"playing":false}',
  ]).finish();

  assert.equal(record.trailingStallRatio, 0);
  assert.equal(record.stuckPrerolling, true);
});

test('a viewer from a build with no playing flag is read as playing', () => {
  // Every fixture captured before pre-roll was separated from stalling.
  const record = fold([
    '{"t":600,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":500,"segment_s":2,"buffered_s":2}',
  ]).finish();
  assert.equal(record.stuckPrerolling, false);
});

test('realtime factor is fetch time against playback time', () => {
  const record = fold([
    // 500 ms to fetch 2 s of media is 0.25; 3000 ms is 1.5, which loses buffer.
    '{"t":600,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":500,"segment_s":2,"buffered_s":2}',
    '{"t":3600,"ev":"segment","sequence":2,"bytes":1,"fetch_ms":3000,"segment_s":2,"buffered_s":0}',
  ]).finish();
  assert.equal(record.realtimeFactor.p50, 0.875);
  assert.equal(record.realtimeFactor.max, 1.5);
});

test('the summary wins, because the viewer measured it against its own clock', () => {
  const record = fold([
    '{"t":600,"ev":"segment","sequence":1,"bytes":1000,"fetch_ms":500,"segment_s":2,"buffered_s":2}',
    '{"t":9000,"ev":"summary","segments":50,"bytes":5000000,"media_s":100,"wall_s":96.2,"stalls":1,"stalled_s":0.21,"skipped":0,"gaps":0,"body_failures":2}',
  ]).finish();
  assert.equal(record.segments, 50);
  assert.equal(record.bytes, 5_000_000);
  assert.equal(record.stalledS, 0.21);
  assert.equal(record.summarySeen, true);
});

test('a body failure count from events survives a summary that reports fewer', () => {
  const record = fold([
    '{"t":1,"ev":"body_failure","sequence":1,"strike":1,"attempts":6}',
    '{"t":2,"ev":"body_failure","sequence":1,"strike":2,"attempts":6}',
    '{"t":3,"ev":"summary","segments":0,"bytes":0,"body_failures":0}',
  ]).finish();
  assert.equal(record.bodyFailures, 2);
  assert.equal(record.secondStrikes, 1);
});

test('gaps are split by cause, because ours and the publisher’s mean different things', () => {
  const record = fold([
    '{"t":1,"ev":"gap","sequence":1,"source":"publisher"}',
    '{"t":2,"ev":"gap","sequence":2,"source":"local"}',
    '{"t":3,"ev":"gap","sequence":3,"source":"local"}',
  ]).finish();
  assert.equal(record.gapsPublisher, 1);
  assert.equal(record.gapsLocal, 2);
});

test('a skip counts every sequence it stepped over', () => {
  const record = fold(['{"t":1,"ev":"skip","from":100,"to":107}']).finish();
  assert.equal(record.skipped, 7);
});

test('a signal we asked for is not a crash', () => {
  const rollup = fold([
    '{"t":1,"ev":"joined","join_ms":1,"feed_index":1,"start_sequence":1,"runway_s":8,"window":10}',
    '{"t":2,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":10,"segment_s":2,"buffered_s":2}',
  ]);
  rollup.noteExit({ code: null, signal: 'SIGTERM', requested: true }, 5_000);
  assert.equal(rollup.finish().outcome, 'killed');
});

test('a signal we did not ask for is a crash', () => {
  const rollup = fold([]);
  rollup.noteExit({ code: null, signal: 'SIGSEGV', requested: false }, 5_000);
  assert.equal(rollup.finish().outcome, 'crashed');
});

test('a live viewer that never joined is its own outcome', () => {
  const rollup = fold(['{"t":1,"ev":"error","stage":"join","message":"no runway"}']);
  rollup.noteExit({ code: 1, signal: null, requested: false }, 5_000);
  // Exit code 1 without a signal reads as a crash first; the join failure is in
  // `errors`, and a clean exit that never joined is `never_joined`.
  assert.equal(rollup.finish().outcome, 'crashed');

  const clean = fold([]);
  clean.noteExit({ code: 0, signal: null, requested: false }, 5_000);
  assert.equal(clean.finish().outcome, 'never_joined');
});

test('a viewer that watched but barely is stalled_out, not completed', () => {
  const rollup = fold([
    '{"t":1,"ev":"joined","join_ms":1,"feed_index":1,"start_sequence":1,"runway_s":8,"window":10}',
    '{"t":2,"ev":"segment","sequence":1,"bytes":1,"fetch_ms":10,"segment_s":2,"buffered_s":2}',
    '{"t":3,"ev":"segment","sequence":2,"bytes":1,"fetch_ms":10,"segment_s":2,"buffered_s":0,"stalled":true,"stall_s":3}',
  ]);
  rollup.noteExit({ code: 0, signal: null, requested: false }, 5_000);
  const record = rollup.finish();
  assert.equal(record.stallRatio, 0.75);
  assert.equal(record.outcome, 'stalled_out');
});

test('malformed lines are counted without disturbing the numbers', () => {
  const rollup = fold([
    'INFO some tracing line that ended up on stdout',
    '{"t":2,"ev":"segment","sequence":1,"bytes":1000,"fetch_ms":10,"segment_s":2,"buffered_s":2}',
  ]);
  const record = rollup.finish();
  assert.equal(record.malformedLines, 1);
  assert.equal(record.segments, 1);
});

test('resource samples come from the agent, not the viewer', () => {
  const rollup = fold([]);
  rollup.noteResource(30 * 1024 * 1024, 1.5);
  rollup.noteResource(43 * 1024 * 1024, 2.5);
  rollup.noteResource(41 * 1024 * 1024, 3.0);
  const record = rollup.finish();
  assert.equal(record.peakRssBytes, 43 * 1024 * 1024);
  assert.equal(record.cpuSeconds, 3.0);
});
