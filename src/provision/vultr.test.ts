import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VultrClient, VultrError, isRetryable, type FetchLike } from './vultr.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
  authorization: string | undefined;
}

/** A fake transport that records what was asked and replies from a script. */
function fakeFetch(replies: (Response | (() => Response))[]): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let at = 0;
  const fetch: FetchLike = (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      authorization: headers['Authorization'],
    });
    const next = replies[at] ?? replies[replies.length - 1];
    at += 1;
    // Cloned, never handed out directly: a reply reused for a repeated call
    // would otherwise arrive with its body already consumed.
    return Promise.resolve(typeof next === 'function' ? next() : (next as Response).clone());
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const noSleep = (): Promise<void> => Promise.resolve();

test('pagination follows the cursor until the provider stops offering one', async () => {
  const { fetch, calls } = fakeFetch([
    json({ regions: [{ id: 'fra', city: 'F', country: 'DE', continent: 'Europe' }], meta: { links: { next: 'abc' } } }),
    json({ regions: [{ id: 'ams', city: 'A', country: 'NL', continent: 'Europe' }], meta: { links: { next: '' } } }),
  ]);
  const client = new VultrClient({ fetch, sleep: noSleep, minIntervalMs: 0 });

  assert.deepEqual((await client.listRegions()).map((region) => region.id), ['fra', 'ams']);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.url.includes('cursor=abc'), calls[1]?.url);
});

test('the catalogue is readable without a key, which is how sizing runs first', async () => {
  const { fetch, calls } = fakeFetch([json({ plans: [], meta: { links: { next: '' } } })]);
  const client = new VultrClient({ fetch, sleep: noSleep, minIntervalMs: 0 });

  assert.equal(client.hasKey, false);
  await client.listPlans();
  assert.equal(calls[0]?.authorization, undefined);
});

test('a tagged listing asks the provider to filter, not this process', async () => {
  // Teardown depends on it: the tag is the record, so the query has to carry it.
  const { fetch, calls } = fakeFetch([json({ instances: [], meta: { links: { next: '' } } })]);
  const client = new VultrClient({ apiKey: 'k', fetch, sleep: noSleep, minIntervalMs: 0 });

  await client.listInstances('swarm-fleet-20260909-1200');
  assert.ok(calls[0]?.url.includes('tag=swarm-fleet-20260909-1200'), calls[0]?.url);
  assert.equal(calls[0]?.authorization, 'Bearer k');
});

test('cloud-init travels base64, and backups are never on', async () => {
  const { fetch, calls } = fakeFetch([json({ instance: { id: 'i-1', main_ip: '0.0.0.0' } })]);
  const client = new VultrClient({ apiKey: 'k', fetch, sleep: noSleep, minIntervalMs: 0 });

  await client.createInstance({
    region: 'fra',
    plan: 'voc-c-4c-8gb-75s-amd',
    osId: 2136,
    label: 'swarm-fleet-x-000',
    hostname: 'swarm-fleet-x-000',
    tags: ['swarm-fleet', 'swarm-fleet-x'],
    sshKeyIds: ['key-1'],
    userData: '#!/bin/sh\necho hello\n',
  });

  const body = calls[0]?.body as Record<string, unknown>;
  assert.deepEqual(body['tags'], ['swarm-fleet', 'swarm-fleet-x']);
  assert.equal(body['backups'], 'disabled');
  assert.equal(Buffer.from(body['user_data'] as string, 'base64').toString('utf8'), '#!/bin/sh\necho hello\n');
});

test('429 is retried and 4xx is not, because a retried create rents a second box', async () => {
  const rateLimited = fakeFetch([
    json({ error: 'rate limited' }, 429),
    json({ instance: { id: 'i-1' } }),
  ]);
  const client = new VultrClient({
    apiKey: 'k',
    fetch: rateLimited.fetch,
    sleep: noSleep,
    minIntervalMs: 0,
  });
  assert.equal((await client.createInstance(createInput())).id, 'i-1');
  assert.equal(rateLimited.calls.length, 2);

  const rejected = fakeFetch([json({ error: 'plan not available in region' }, 400)]);
  const strict = new VultrClient({
    apiKey: 'k',
    fetch: rejected.fetch,
    sleep: noSleep,
    minIntervalMs: 0,
  });
  await assert.rejects(strict.createInstance(createInput()), (error: unknown) => {
    assert.ok(error instanceof VultrError);
    assert.equal(error.status, 400);
    assert.match(error.message, /plan not available/);
    return true;
  });
  assert.equal(rejected.calls.length, 1, 'a 400 must not be retried');
});

test('deleting something already gone is success, not an error', async () => {
  // Teardown is run repeatedly and from stale state; it has to converge.
  const { fetch } = fakeFetch([json({ error: 'not found' }, 404)]);
  const client = new VultrClient({ apiKey: 'k', fetch, sleep: noSleep, minIntervalMs: 0 });
  assert.equal(await client.deleteInstance('i-gone'), 'absent');

  const empty = fakeFetch([new Response(null, { status: 204 })]);
  const other = new VultrClient({
    apiKey: 'k',
    fetch: empty.fetch,
    sleep: noSleep,
    minIntervalMs: 0,
  });
  assert.equal(await other.deleteInstance('i-1'), 'deleted');
});

test('a locked delete is retried, because giving up leaves a box billing', async () => {
  // What the first real provisioning run hit: three instances created, the
  // fourth refused by an account limit, and the rollback could not delete two
  // of the three because Vultr locks an instance while it installs.
  assert.equal(isRetryable('DELETE', 409), true);
  assert.equal(isRetryable('POST', 409), false, 'a retried create could rent a second box');
  assert.equal(isRetryable('GET', 404), false);
  assert.equal(isRetryable('POST', 429), true);
  assert.equal(isRetryable('POST', 503), true);

  const { fetch, calls } = fakeFetch([
    json({ error: 'Server is currently locked' }, 409),
    json({ error: 'Server is currently locked' }, 409),
    new Response(null, { status: 204 }),
  ]);
  const client = new VultrClient({ apiKey: 'k', fetch, sleep: noSleep, minIntervalMs: 0 });

  assert.equal(await client.deleteInstance('i-locked'), 'deleted');
  assert.equal(calls.length, 3);
});

test('a delete gets a longer budget than the default four attempts', async () => {
  // The install lock outlasts ~4 s of backoff, which is what the default spans.
  const { fetch, calls } = fakeFetch([json({ error: 'Server is currently locked' }, 409)]);
  const client = new VultrClient({
    apiKey: 'k',
    fetch,
    sleep: noSleep,
    minIntervalMs: 0,
    retries: 1,
    deleteRetries: 6,
  });

  await assert.rejects(client.deleteInstance('i-stuck'), /locked/);
  assert.equal(calls.length, 7, 'delete uses deleteRetries, not retries');
});

test('concurrent callers queue behind the rate gate rather than racing it', async () => {
  const waits: number[] = [];
  const { fetch, calls } = fakeFetch([json({ instances: [], meta: { links: { next: '' } } })]);
  const client = new VultrClient({
    apiKey: 'k',
    fetch,
    minIntervalMs: 50,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });

  await Promise.all([client.listInstances(), client.listInstances(), client.listInstances()]);
  assert.equal(calls.length, 3);
  // The first call is free; the two behind it each wait out the interval.
  assert.equal(waits.filter((ms) => ms > 0).length, 2);
});

function createInput(): Parameters<VultrClient['createInstance']>[0] {
  return {
    region: 'fra',
    plan: 'voc-c-4c-8gb-75s-amd',
    osId: 2136,
    label: 'l',
    hostname: 'l',
    tags: ['swarm-fleet'],
    sshKeyIds: ['key-1'],
    userData: '#!/bin/sh\n',
  };
}
