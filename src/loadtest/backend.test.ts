/**
 * What the client does with each of the server's answers.
 *
 * The three outcomes are not interchangeable and the difference is not
 * cosmetic: a participant whose report is refused because the backend was
 * restarted against an empty data directory is still running twenty viewers
 * against mainnet, so treating that as "offline" would keep the load and lose
 * the record of it for the rest of the event. These tests pin which answer
 * means which.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Backend, BackendError } from './backend.js';
import type { LoadtestReport } from './protocol.js';

const REPORT: LoadtestReport = {
  sessionId: 'a-session',
  atMs: 1_000,
  uptimeS: 15,
  viewers: 20,
  targetViewers: 20,
  bootstrapping: 0,
  mediaMbps: 40,
  segments: 100,
  bytes: 50_000_000,
  stalls: 0,
  exited: 0,
  leaving: false,
};

function answering(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function refusing(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

test('a good report comes back as the leaderboard', async () => {
  const backend = new Backend({
    base: 'http://loadtest.invalid/',
    fetchImpl: answering(200, {
      ok: true,
      serverTimeMs: 2_000,
      settings: {},
      stream: { owner: 'aa', topic: 'bb' },
      totals: {
        participants: 1,
        online: 1,
        viewers: 20,
        peakViewers: 20,
        mediaMbps: 40,
        totalBytes: 1,
        segments: 1,
      },
      leaderboard: [],
      rank: 1,
    }),
  });
  const outcome = await backend.report(REPORT);
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.kind === 'ok' ? outcome.response.rank : undefined, 1);
});

test('a session the server has forgotten asks for a rejoin, not a shrug', async () => {
  const backend = new Backend({
    base: 'http://loadtest.invalid',
    fetchImpl: answering(409, { error: 'unknown session; join again' }),
  });
  const outcome = await backend.report(REPORT);
  assert.equal(outcome.kind, 'rejoin');
  assert.match(outcome.detail, /unknown session/);
});

test('a server that is down or broken is unreachable, and the viewers carry on', async () => {
  for (const http of [refusing(), answering(500, { error: 'no' })]) {
    const backend = new Backend({ base: 'http://loadtest.invalid', fetchImpl: http });
    assert.equal((await backend.report(REPORT)).kind, 'unreachable');
  }
});

test('a stream that is not up yet is worth waiting for; a bad request is not', async () => {
  const notYet = new Backend({
    base: 'http://loadtest.invalid',
    fetchImpl: answering(503, { error: 'there is no live stream yet' }),
  });
  await assert.rejects(notYet.join({ protocol: 1, client: 'test' }), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.retryable, true, 'a 503 is the event not having started');
    assert.match(error.message, /no live stream yet/, 'the server says why, in its own words');
    return true;
  });

  const wrong = new Backend({
    base: 'http://loadtest.invalid',
    fetchImpl: answering(400, { error: 'that is not a join request' }),
  });
  await assert.rejects(wrong.join({ protocol: 1, client: 'test' }), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.retryable, false, 'retrying a request the server understood and refused');
    return true;
  });
});
