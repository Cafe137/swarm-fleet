import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseViewerEvent } from './contract.js';

test('a segment event parses with its defaults applied', () => {
  const result = parseViewerEvent(
    '{"t":1200,"ev":"segment","sequence":96,"bytes":260000,"fetch_ms":540,"segment_s":2,"buffered_s":7.4}',
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.known, true);
  assert.equal(result.event.ev, 'segment');
  assert.equal(result.event['stalled'], false);
  assert.equal(result.event['stall_s'], 0);
  assert.equal(result.event['attempts'], 1);
});

test('an unknown ev is kept and flagged, never fatal', () => {
  // Adding an event on the Rust side must not break a runner mid-run.
  const result = parseViewerEvent('{"t":5,"ev":"something_new","detail":"whatever"}');
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.known, false);
  assert.equal(result.event['detail'], 'whatever');
});

test('unknown fields on a known event pass through', () => {
  // A field a newer viewer adds must not reject the event on an older fleet.
  const result = parseViewerEvent(
    '{"t":1,"ev":"peers","peers":42,"future_field":true}',
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.event['future_field'], true);
  assert.equal(result.event['peers'], 42);
});

test('garbage is a datum about the viewer, not an exception', () => {
  assert.deepEqual(parseViewerEvent('not json at all'), { ok: false, reason: 'not json' });
  assert.deepEqual(parseViewerEvent('  '), { ok: false, reason: 'empty' });
  assert.equal(parseViewerEvent('{"ev":"segment"}').ok, false);
});

test('a stray tracing line on stdout costs one line, not the run', () => {
  const result = parseViewerEvent('2026-09-08T10:00:00Z  INFO weeb_3: node started');
  assert.equal(result.ok, false);
});
