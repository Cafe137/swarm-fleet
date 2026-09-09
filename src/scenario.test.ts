import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublisherConfig, segmentsBeforeViewersCanJoin } from './publisher/config.js';
import { resolveScenario } from './scenario.js';

const base = {
  mode: 'cohort' as const,
  binary: 'mock',
  viewers: 2,
  segments: 4,
};

test('a run with nothing to watch is refused, and says how to fix it', () => {
  assert.throws(() => resolveScenario({ ...base, streams: [] }), /no stream to watch/);
  assert.throws(() => resolveScenario({ ...base, streams: [] }), /--publish/);
});

test('a publishing run supplies its own stream, so it needs none up front', () => {
  // The CLI starts the publisher and prepends the stream it creates before
  // this runs, which is why an empty `streams` is only legal with a publisher.
  const scenario = resolveScenario({
    ...base,
    streams: [{ owner: 'aa', topic: 'bb' }],
    publisher: { segmentDuration: 4 },
  });
  assert.equal(scenario.publisher?.segmentDuration, 4);
  // Defaults are filled in, so `run.json` records what actually ran.
  assert.equal(scenario.publisher?.source, 'testsrc');
  assert.equal(scenario.publisher?.windowSize, 10);
});

/** Every scenario carries the unverified-chunks caveat by default; skip it. */
function publisherCaveats(caveats: readonly string[]): string[] {
  return caveats.filter((caveat) => !caveat.includes('chunk content verification'));
}

test('an unverified run says so, because its CPU figures are optimistic', () => {
  const unsafe = resolveScenario({ ...base, streams: [{ owner: 'aa', topic: 'bb' }] });
  assert.equal(unsafe.spec.verifyChunks, false);
  assert.match(unsafe.caveats.join(' '), /chunk content verification was off/);

  const verified = resolveScenario({
    ...base,
    streams: [{ owner: 'aa', topic: 'bb' }],
    verifyChunks: true,
  });
  assert.equal(verified.spec.verifyChunks, true);
  assert.deepEqual(verified.caveats, []);
});

test('a publisher sharing a machine with viewers is a standing caveat', () => {
  const shared = resolveScenario({
    ...base,
    streams: [{ owner: 'aa', topic: 'bb' }],
    publisher: {},
    agents: [{ host: 'local' }],
  });
  assert.match(shared.caveats.join(' '), /also hosted viewers/);

  const separate = resolveScenario({
    ...base,
    streams: [{ owner: 'aa', topic: 'bb' }],
    publisher: {},
    agents: [{ host: 'box-a' }],
  });
  assert.deepEqual(publisherCaveats(separate.caveats), []);

  // No publisher, no caveat, whatever the agents are.
  const plain = resolveScenario({ ...base, streams: [{ owner: 'aa', topic: 'bb' }] });
  assert.equal(plain.publisher, undefined);
  assert.deepEqual(publisherCaveats(plain.caveats), []);
});

test('viewers wait for as much runway as the viewer actually needs', () => {
  // HLS_LIVE_STARTUP_BUFFER_SECONDS is 8 in the viewer, and the newest segment
  // is the edge rather than part of the runway behind it.
  const at = (segmentDuration: number): number =>
    segmentsBeforeViewersCanJoin(PublisherConfig.parse({ segmentDuration }));
  assert.equal(at(2), 5);
  assert.equal(at(4), 3);
  assert.equal(at(10), 2);
  assert.equal(at(1), 9);

  // An explicit setting wins, for deliberately joining a thinner window.
  assert.equal(
    segmentsBeforeViewersCanJoin(PublisherConfig.parse({ segmentDuration: 2, readySegments: 2 })),
    2,
  );
});
