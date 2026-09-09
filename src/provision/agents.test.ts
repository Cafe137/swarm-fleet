import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Args } from '../args.js';
import { sshArgs } from '../transport/ssh.js';
import { agentsFromArgs } from './agents.js';
import { fleetTag, writeFleetState, type ProvisionedFleet } from './provision.js';

async function fleetIn(dir: string, fleetId = 'test'): Promise<ProvisionedFleet> {
  const fleet: ProvisionedFleet = {
    fleetId,
    provider: 'vultr',
    createdAt: '2026-09-09T20:39:46.000Z',
    tag: fleetTag(fleetId),
    plan: 'vc2-4c-8gb',
    osId: 2136,
    sshUser: 'root',
    regions: ['fra', 'ams'],
    instances: [
      { id: 'i-0', label: 'swarm-fleet-test-000', region: 'fra', ip: '203.0.113.1' },
      { id: 'i-1', label: 'swarm-fleet-test-001', region: 'ams', ip: '203.0.113.2' },
    ],
    destroyWith: `swarm-fleet destroy --fleet ${fleetId}`,
  };
  await writeFleetState(dir, fleet);
  return fleet;
}

const stateDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-agents-'));

test('--fleet carries the ssh settings that a bare --agent string cannot', async () => {
  // The regression this exists for. `provision` used to print five
  // `--agent root@<ip>` flags, and parsing those loses `ephemeralHost` — so the
  // first real run died at `Host key verification failed` before uploading a
  // byte, because a box created ten minutes ago is in nobody's known_hosts and
  // BatchMode turns first contact into a failure rather than a prompt.
  const dir = await stateDir();
  await fleetIn(dir);

  const fromFleet = await agentsFromArgs(new Args(['--fleet', 'test', '--state-dir', dir]));
  assert.equal(fromFleet.length, 2);
  for (const target of fromFleet) {
    assert.equal(target.ephemeralHost, true);
    assert.equal(target.user, 'root');
    assert.ok(sshArgs(target).includes('StrictHostKeyChecking=no'));
  }
  assert.deepEqual(fromFleet.map((target) => target.host), ['203.0.113.1', '203.0.113.2']);
  assert.deepEqual(fromFleet.map((target) => target.name), [
    'swarm-fleet-test-000',
    'swarm-fleet-test-001',
  ]);

  // The same machines named the old way still fail, which is why --fleet exists.
  const asStrings = await agentsFromArgs(new Args(['--agent', 'root@203.0.113.1']));
  assert.equal(asStrings[0]?.ephemeralHost, undefined);
  assert.ok(!sshArgs(asStrings[0] as { host: string }).includes('StrictHostKeyChecking=no'));
});

test('a rented fleet and a permanent box can be in one run', async () => {
  const dir = await stateDir();
  await fleetIn(dir);

  const agents = await agentsFromArgs(
    new Args(['--fleet', 'test', '--state-dir', dir, '--agent', 'box-a']),
  );
  assert.deepEqual(agents.map((target) => target.host), ['203.0.113.1', '203.0.113.2', 'box-a']);
  assert.equal(agents.at(-1)?.ephemeralHost, undefined);
});

test('a fleet that is gone fails now, not thirty seconds into the run', async () => {
  const dir = await stateDir();
  await assert.rejects(
    agentsFromArgs(new Args(['--fleet', 'missing', '--state-dir', dir])),
    /no record of fleet missing/,
  );

  // Destroyed fleets keep their record with an empty instance list, and running
  // against nothing would otherwise look like a run with no agents.
  const fleet = await fleetIn(dir, 'spent');
  await writeFleetState(dir, { ...fleet, instances: [] });
  await assert.rejects(
    agentsFromArgs(new Args(['--fleet', 'spent', '--state-dir', dir])),
    /already destroyed/,
  );
});

test('no --fleet is the ordinary path, and unchanged', async () => {
  assert.deepEqual(await agentsFromArgs(new Args([])), []);
  const named = await agentsFromArgs(new Args(['--agent', 'box-a', '--agent', 'box-b']));
  assert.deepEqual(named.map((target) => target.host), ['box-a', 'box-b']);
  assert.equal(named[0]?.weight, 1);
});
