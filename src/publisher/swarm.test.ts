import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SwarmWriter } from './swarm.js';

/**
 * A fake bee-js upload result. Only `reference.toHex()` is ever read, which is
 * how the writer decides whether a mirror stored what the primary stored.
 */
function stored(hex: string): { reference: { toHex(): string } } {
  return { reference: { toHex: () => hex } };
}

const REF = 'ab'.repeat(32);

/** The url a `Bee` was constructed with, without reaching for a private field. */
function urlOf(bee: unknown): string {
  return String((bee as { url: string }).url).replace(/\/+$/, '');
}

function writerFor(gateway: string, mirrors: readonly string[]): SwarmWriter {
  return SwarmWriter.open(gateway, mirrors);
}

test('a mirror that is the primary under another spelling is dropped', () => {
  const writer = writerFor('https://bzz.limo', [
    'https://BZZ.limo/',
    'https://api.gateway.ethswarm.org',
    'https://api.gateway.ethswarm.org/',
  ]);
  assert.deepEqual(writer.mirrorGateways, ['https://api.gateway.ethswarm.org']);
});

test('no mirrors is a supported configuration, not a special case', async () => {
  const writer = writerFor('https://bzz.limo', []);
  assert.deepEqual(writer.mirrorGateways, []);
  const result = await writer.fanOut(async () => stored(REF));
  assert.equal(result.reference.toHex(), REF);
  assert.deepEqual(writer.report(), []);
});

test('the primary decides the reference, and a failing mirror cannot change it', async () => {
  const writer = writerFor('https://primary.example', ['https://mirror.example']);
  const seen: string[] = [];

  const result = await writer.fanOut(async (bee) => {
    seen.push(urlOf(bee));
    if (urlOf(bee) === 'https://mirror.example') {
      throw new Error('mirror is down');
    }
    return stored(REF);
  });

  assert.equal(result.reference.toHex(), REF);
  // Both were asked at the same time; the primary is the one that was awaited.
  assert.ok(seen.includes('https://primary.example'));
  assert.ok(seen.includes('https://mirror.example'));

  await writer.drain(2_000);
  const [mirror] = writer.report();
  assert.equal(mirror?.ok, 0);
  // Two attempts, and the mirror's own retry does not stall the primary.
  assert.equal(mirror?.failed, 1);
});

test('a mirror never delays the primary', async () => {
  const writer = writerFor('https://primary.example', ['https://slow.example']);
  let releaseMirror = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    releaseMirror = resolve;
  });

  const started = Date.now();
  const result = await writer.fanOut(async (bee) => {
    if (urlOf(bee) === 'https://slow.example') {
      await held;
    }
    return stored(REF);
  });

  // The primary resolved while the mirror was still parked.
  assert.equal(result.reference.toHex(), REF);
  assert.ok(Date.now() - started < 1_000);
  releaseMirror();
  await writer.drain(2_000);
  assert.equal(writer.report()[0]?.ok, 1);
});

test('a mirror that falls too far behind is skipped rather than queued', async () => {
  const writer = writerFor('https://primary.example', ['https://slow.example']);
  const warnings: string[] = [];
  writer.onWarning((message) => warnings.push(message));

  let releaseMirror = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    releaseMirror = resolve;
  });
  const work = async (bee: { url: string }): Promise<ReturnType<typeof stored>> => {
    if (urlOf(bee) === 'https://slow.example') {
      await held;
    }
    return stored(REF);
  };

  // MAX_IN_FLIGHT is 4, so the fifth and sixth writes find the mirror full.
  for (let at = 0; at < 6; at += 1) {
    await writer.fanOut(work as never);
  }

  const [mirror] = writer.report();
  assert.equal(mirror?.dropped, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /falling behind|fell .* behind/);

  releaseMirror();
  await writer.drain(2_000);
  assert.equal(writer.report()[0]?.ok, 4);
});

test('a mirror is abandoned after five consecutive failures', async () => {
  const writer = writerFor('https://primary.example', ['https://broken.example']);
  const warnings: string[] = [];
  writer.onWarning((message) => warnings.push(message));

  for (let at = 0; at < 6; at += 1) {
    await writer.fanOut(async (bee) => {
      if (urlOf(bee) === 'https://broken.example') {
        throw new Error('502');
      }
      return stored(REF);
    });
    await writer.drain(2_000);
  }

  const [mirror] = writer.report();
  assert.equal(mirror?.disabled, true);
  // The sixth write was never attempted, so the count stops at the limit.
  assert.equal(mirror?.failed, 5);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /502/);
});

test('a mirror storing a different reference is dropped, and the run is warned', async () => {
  const writer = writerFor('https://primary.example', ['https://odd.example']);
  const warnings: string[] = [];
  writer.onWarning((message) => warnings.push(message));

  const result = await writer.fanOut(async (bee) =>
    stored(urlOf(bee) === 'https://odd.example' ? 'cd'.repeat(32) : REF),
  );
  assert.equal(result.reference.toHex(), REF);

  await writer.drain(2_000);
  const [mirror] = writer.report();
  assert.equal(mirror?.disabled, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /propagating different chunks/);
});

test('drain gives up rather than holding a finished run open', async () => {
  const writer = writerFor('https://primary.example', ['https://stuck.example']);
  await writer.fanOut(async (bee) => {
    if (urlOf(bee) === 'https://stuck.example') {
      await new Promise(() => undefined);
    }
    return stored(REF);
  });

  const started = Date.now();
  await writer.drain(150);
  assert.ok(Date.now() - started < 2_000);
});
