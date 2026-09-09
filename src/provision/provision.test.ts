import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cloudInitScript, FAILED_SENTINEL, READY_SENTINEL } from './cloud-init.js';
import {
  FLEET_TAG,
  agentTargetsFor,
  destroyFleet,
  fleetTag,
  listFleetStates,
  newFleetId,
  provisionFleet,
  readFleetState,
  singleQuote,
  writeFleetState,
  type ProvisionedFleet,
} from './provision.js';
import { sameKey } from './ssh-key.js';
import { sshArgs } from '../transport/ssh.js';
import type { VultrClient, VultrInstance } from './vultr.js';

/**
 * A stand-in provider. `createInstance` can be made to fail at a chosen index,
 * which is how the rollback path is exercised without renting anything.
 */
class FakeVultr {
  readonly created: VultrInstance[] = [];
  readonly deleted: string[] = [];
  failAt: number | undefined;
  private next = 0;

  createInstance(input: {
    region: string;
    label: string;
    tags: string[];
  }): Promise<VultrInstance> {
    if (this.next === this.failAt) {
      this.next += 1;
      return Promise.reject(new Error('plan not available in region'));
    }
    const instance: VultrInstance = {
      id: `i-${this.next}`,
      label: input.label,
      region: input.region,
      plan: 'voc-c-4c-8gb-75s-amd',
      // Vultr hands back 0.0.0.0 and assigns an address a moment later.
      main_ip: '0.0.0.0',
      status: 'pending',
      server_status: 'none',
      power_status: 'running',
      date_created: '2026-09-09T19:00:00+00:00',
      tags: input.tags,
    };
    this.next += 1;
    this.created.push(instance);
    return Promise.resolve(instance);
  }

  listInstances(tag?: string): Promise<VultrInstance[]> {
    const live = this.created
      .filter((instance) => !this.deleted.includes(instance.id))
      .filter((instance) => tag === undefined || instance.tags.includes(tag))
      // Addressed by the time anyone asks, which is what the poll waits for.
      .map((instance) => ({ ...instance, main_ip: `10.0.0.${instance.id.slice(2)}`, status: 'active' }));
    return Promise.resolve(live);
  }

  deleteInstance(id: string): Promise<'deleted' | 'absent'> {
    this.deleted.push(id);
    return Promise.resolve('deleted');
  }

  asClient(): VultrClient {
    return this as unknown as VultrClient;
  }
}

const stateDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-provision-'));

test('a fleet id is sortable, and its tag namespaces it under the rig tag', () => {
  const id = newFleetId(new Date(2026, 8, 9, 19, 21, 5));
  assert.equal(id, '20260909-192105');
  assert.equal(fleetTag(id), 'swarm-fleet-20260909-192105');
  // Both tags, so `--all` finds every fleet and `--fleet` finds exactly one.
  assert.ok(fleetTag(id).startsWith(FLEET_TAG));
});

test('a failure part-way through destroys what was already rented', async () => {
  // The expensive mistake this prevents: eight boxes billing by the hour
  // because the ninth was refused.
  const vultr = new FakeVultr();
  vultr.failAt = 3;
  const dir = await stateDir();

  await assert.rejects(
    provisionFleet({
      client: vultr.asClient(),
      count: 5,
      plan: 'voc-c-4c-8gb-75s-amd',
      regions: ['fra', 'ams'],
      sshKeyIds: ['key-1'],
      stateDir: dir,
      fleetId: 'test',
    }),
    /plan not available/,
  );

  assert.equal(vultr.created.length, 3);
  assert.deepEqual(vultr.deleted, ['i-0', 'i-1', 'i-2']);
  // And the record says so, rather than listing boxes that no longer exist.
  assert.deepEqual((await readFleetState(dir, 'test'))?.instances, []);
});

test('the state file is rewritten per instance, so a crash still names them', async () => {
  const vultr = new FakeVultr();
  const dir = await stateDir();
  // No readiness probing: that path needs ssh, and is covered by probeReady's
  // own contract. Timing out here proves the file was written before the wait.
  await assert.rejects(
    provisionFleet({
      client: vultr.asClient(),
      count: 2,
      plan: 'p',
      regions: ['fra'],
      sshKeyIds: ['key-1'],
      stateDir: dir,
      fleetId: 'crash',
      readyTimeoutMs: 0,
      pollIntervalMs: 1,
    }),
    /timed out/,
  );
  // Rolled back, but the run happened: both were created before the wait began.
  assert.equal(vultr.created.length, 2);
  assert.deepEqual(vultr.deleted, ['i-0', 'i-1']);
});

test('regions round-robin across the instances of one fleet', async () => {
  const vultr = new FakeVultr();
  vultr.failAt = 3;
  await assert.rejects(
    provisionFleet({
      client: vultr.asClient(),
      count: 5,
      plan: 'p',
      regions: ['fra', 'ams', 'lhr'],
      sshKeyIds: ['key-1'],
      stateDir: await stateDir(),
      fleetId: 'spread',
    }),
  );
  assert.deepEqual(vultr.created.map((instance) => instance.region), ['fra', 'ams', 'lhr']);
});

test('teardown asks the provider, so a lost state file is not a lost fleet', async () => {
  const vultr = new FakeVultr();
  await vultr.createInstance({ region: 'fra', label: 'a', tags: [FLEET_TAG, fleetTag('one')] });
  await vultr.createInstance({ region: 'ams', label: 'b', tags: [FLEET_TAG, fleetTag('two')] });

  // No state directory at all: the tag is the record.
  const one = await destroyFleet({ client: vultr.asClient(), fleetId: 'one', stateDir: '/nonexistent' });
  assert.deepEqual(one.destroyed.map((instance) => instance.label), ['a']);

  const rest = await destroyFleet({ client: vultr.asClient(), stateDir: '/nonexistent' });
  assert.deepEqual(rest.destroyed.map((instance) => instance.label), ['b']);
});

test('provisioned hosts become agent targets that skip known_hosts', () => {
  const fleet: ProvisionedFleet = {
    fleetId: 'x',
    provider: 'vultr',
    createdAt: '2026-09-09T19:00:00.000Z',
    tag: fleetTag('x'),
    plan: 'p',
    osId: 2136,
    sshUser: 'root',
    regions: ['fra'],
    instances: [{ id: 'i-0', label: 'swarm-fleet-x-000', region: 'fra', ip: '203.0.113.10' }],
    destroyWith: 'swarm-fleet destroy --fleet x',
  };

  const [target] = agentTargetsFor(fleet);
  assert.equal(target?.host, '203.0.113.10');
  assert.equal(target?.user, 'root');
  assert.equal(target?.ephemeralHost, true);

  // Without this a fresh box refuses every connection: BatchMode turns the
  // first-contact prompt into a failure.
  const args = sshArgs(target as { host: string; user: string; ephemeralHost: boolean });
  assert.ok(args.includes('StrictHostKeyChecking=no'), args.join(' '));
  assert.ok(args.includes('UserKnownHostsFile=/dev/null'));
  assert.equal(args.at(-1), 'root@203.0.113.10');

  // And an ordinary host is untouched.
  assert.ok(!sshArgs({ host: 'box-a' }).includes('StrictHostKeyChecking=no'));
});

test('fleet records round-trip and list newest first', async () => {
  const dir = await stateDir();
  const base: ProvisionedFleet = {
    fleetId: '20260909-120000',
    provider: 'vultr',
    createdAt: '2026-09-09T12:00:00.000Z',
    tag: fleetTag('20260909-120000'),
    plan: 'voc-c-4c-8gb-75s-amd',
    osId: 2136,
    sshUser: 'root',
    regions: ['fra'],
    instances: [{ id: 'i-0', label: 'l', region: 'fra', ip: '203.0.113.1' }],
    destroyWith: 'swarm-fleet destroy --fleet 20260909-120000',
  };
  await writeFleetState(dir, base);
  await writeFleetState(dir, { ...base, fleetId: '20260909-130000' });

  assert.deepEqual(await readFleetState(dir, base.fleetId), base);
  assert.deepEqual(
    (await listFleetStates(dir)).map((fleet) => fleet.fleetId),
    ['20260909-130000', '20260909-120000'],
  );
  assert.equal(await readFleetState(dir, 'nope'), undefined);
});

test('cloud-init installs a pinned Node, widens the port range, and signals both ways', () => {
  const script = cloudInitScript();

  // Pinned and checksummed: an agent whose Node version drifts is a run that
  // cannot be compared with the last one.
  assert.match(script, /nodejs\.org\/dist\/v\d+\.\d+\.\d+\//);
  assert.match(script, /sha256sum -c -/);

  // 28,232 ports is ~220 viewers at 128 peers, and CLAUDE.md calls that the
  // first ceiling a box hits.
  assert.match(script, /net\.ipv4\.ip_local_port_range = 10240 65535/);

  // apt on a timer would spend CPU on the one machine measuring CPU.
  assert.match(script, /unattended-upgrades/);

  // Both sentinels: readiness has to be able to fail fast, not only time out.
  assert.ok(script.includes(READY_SENTINEL));
  assert.ok(script.includes(FAILED_SENTINEL));
  assert.match(script, /trap - EXIT/);

  // No stray JS interpolation left in what will be run as root.
  assert.ok(!script.includes('${'), 'unexpanded template expression in cloud-init');
});

test('ssh keys match on material, not on the comment the laptop appended', () => {
  const body = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample';
  assert.ok(sameKey(`${body} aron@laptop`, `${body} aron@desktop`));
  assert.ok(sameKey(`${body}\n`, ` ${body} `));
  assert.ok(!sameKey(body, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIother'));
});

test('remote probe scripts survive the shell', () => {
  assert.equal(singleQuote("it's"), `'it'\\''s'`);
});
