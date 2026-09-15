/**
 * The participant's screen.
 *
 * Rendering is tested rather than eyeballed for the same reason the fleet's
 * live view is: the block is redrawn by moving the cursor up as many rows as it
 * printed, so a line that wraps breaks every frame after it. The width rule is
 * the test that matters; the rest is making sure a person can read what it says.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionLines, type SessionState } from './dashboard.js';

const BASE: SessionState = {
  name: 'brave-otter-418',
  elapsedS: 125,
  viewers: 20,
  target: 20,
  bootstrapping: 0,
  step: 20,
  mediaMbps: 41.2,
  segments: 1_284,
  bytes: 2.4 * 1024 ** 3,
  stalls: 0,
  warnings: [],
  stopping: false,
};

/** What the terminal sees, with the colour codes taken back out. */
function plain(state: SessionState, width = 100): string {
  return sessionLines(state, width)
    .join('\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, '');
}

test('it says who you are, what you are running, and which keys do what', () => {
  const text = plain(BASE);
  assert.match(text, /brave-otter-418/);
  assert.match(text, /nodes\s+20 of 20 asked for/);
  assert.match(text, /41\.2 Mbps/);
  assert.match(text, /2\.40 GB/);
  assert.match(text, /right arrow add 20/);
  assert.match(text, /left arrow remove 20/);
  assert.match(text, /q quit/);
});

test('health is a word, not a coefficient', () => {
  assert.match(plain(BASE), /all good/);
  assert.match(plain({ ...BASE, stalls: 3, degradedFraction: 0.1 }), /some stalling/);
  assert.match(plain({ ...BASE, degradedFraction: 0.4 }), /struggling/);
  assert.match(plain({ ...BASE, viewers: 0 }), /nothing running/);
});

test('every line fits the terminal, however long the names are', () => {
  const state: SessionState = {
    ...BASE,
    warnings: ['a'.repeat(400)],
    totals: {
      participants: 12,
      online: 11,
      viewers: 640,
      peakViewers: 800,
      mediaMbps: 1234.5,
      totalBytes: 10 ** 12,
      segments: 99_999,
    },
    leaderboard: Array.from({ length: 12 }, (_, index) => ({
      name: `participant-with-a-very-long-name-${index}`,
      viewers: 100 - index,
      peakViewers: 120,
      mediaMbps: 90 - index,
      totalBytes: 10 ** 10,
      segments: 1_000,
      uptimeS: 600,
      ageMs: 1_000,
      online: true,
    })),
  };
  for (const width of [40, 60, 80, 132]) {
    for (const line of sessionLines(state, width)) {
      const visible = line.replace(/\[[0-9;]*m/g, '');
      assert.ok(
        visible.length <= width,
        `a ${visible.length}-character line in a ${width}-wide terminal: ${visible}`,
      );
    }
  }
});

test('your own row is on screen even when you are nowhere near the top', () => {
  const others = Array.from({ length: 20 }, (_, index) => ({
    name: `other-${index}`,
    viewers: 100 - index,
    peakViewers: 100,
    mediaMbps: 90 - index,
    totalBytes: 1_000,
    segments: 10,
    uptimeS: 60,
    ageMs: 500,
    online: true,
  }));
  const mine = {
    name: BASE.name,
    viewers: 1,
    peakViewers: 1,
    mediaMbps: 0.5,
    totalBytes: 10,
    segments: 1,
    uptimeS: 60,
    ageMs: 500,
    online: true,
  };
  const text = plain({ ...BASE, leaderboard: [...others, mine] });
  assert.match(text, new RegExp(BASE.name));
});

test('a server that has gone quiet is said so on screen', () => {
  const text = plain({ ...BASE, offlineSinceMs: Date.now() - 42_000 });
  assert.match(text, /not reaching the server/);
});
