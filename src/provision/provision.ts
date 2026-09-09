/**
 * Renting the machines, and — the part that actually matters — giving them back.
 *
 * A load rig that provisions is a rig that can leak money. Forty instances left
 * running is real money per day, and the failure modes are ordinary: the
 * controller crashes mid-provision, the laptop closes, someone Ctrl-Cs during
 * the readiness wait. So teardown never depends on local state being intact.
 * Every instance is created carrying a tag, `destroy --all` asks the *provider*
 * which instances carry it, and the state file under `provisioned/` is a
 * convenience for naming one fleet rather than the record teardown relies on.
 *
 * Two other things are deliberate:
 *
 * **Partial provisioning rolls back.** If the ninth of ten instances fails, the
 * eight that succeeded are destroyed before the error is raised. A half-built
 * fleet is not a fleet, and leaving it up to be tidied by hand is how boxes get
 * forgotten.
 *
 * **Ready means cloud-init finished, not that sshd answered.** sshd comes up
 * long before Node is installed, so a deploy that raced readiness would land on
 * a box with no runtime and fail thirty seconds later with a confusing error.
 * The probe reads the sentinel `cloud-init.ts` writes, and reads the failure
 * sentinel too, so a broken image fails the fleet in seconds rather than at the
 * end of a ten-minute timeout.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTarget } from '../scenario.js';
import { sshArgs } from '../transport/ssh.js';
import { cloudInitScript, type CloudInitOptions } from './cloud-init.js';
import { VultrClient, type VultrInstance } from './vultr.js';

/** Carried by every instance this rig creates, in every fleet. */
export const FLEET_TAG = 'swarm-fleet';
/** Debian 12 (bookworm). Its glibc is newer than the ubuntu-22.04 CI builds on. */
export const DEFAULT_OS_ID = 2136;
export const DEFAULT_SSH_USER = 'root';
export const DEFAULT_STATE_DIR = 'provisioned';

export function fleetTag(fleetId: string): string {
  return `${FLEET_TAG}-${fleetId}`;
}

export function newFleetId(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export const ProvisionedInstance = z.object({
  id: z.string(),
  label: z.string(),
  region: z.string(),
  ip: z.string(),
});
export type ProvisionedInstance = z.infer<typeof ProvisionedInstance>;

export const ProvisionedFleet = z.object({
  fleetId: z.string(),
  provider: z.literal('vultr'),
  createdAt: z.string(),
  tag: z.string(),
  plan: z.string(),
  osId: z.number(),
  sshUser: z.string(),
  regions: z.array(z.string()),
  instances: z.array(ProvisionedInstance),
  /** Printed and stored, because the point is that it is never hard to find. */
  destroyWith: z.string(),
});
export type ProvisionedFleet = z.infer<typeof ProvisionedFleet>;

export type ProvisionLog = (level: 'info' | 'warn', message: string) => void;

export interface ProvisionOptions {
  client: VultrClient;
  count: number;
  plan: string;
  regions: readonly string[];
  sshKeyIds: readonly string[];
  osId?: number | undefined;
  sshUser?: string | undefined;
  fleetId?: string | undefined;
  stateDir?: string | undefined;
  cloudInit?: CloudInitOptions | undefined;
  /** Give up waiting for cloud-init. Vultr boots in ~40 s; Node adds ~30 s. */
  readyTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  log?: ProvisionLog | undefined;
  signal?: AbortSignal | undefined;
}

export async function provisionFleet(options: ProvisionOptions): Promise<ProvisionedFleet> {
  const log = options.log ?? (() => undefined);
  const fleetId = options.fleetId ?? newFleetId();
  const tag = fleetTag(fleetId);
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const osId = options.osId ?? DEFAULT_OS_ID;
  const sshUser = options.sshUser ?? DEFAULT_SSH_USER;
  const userData = cloudInitScript(options.cloudInit ?? {});

  const fleet: ProvisionedFleet = {
    fleetId,
    provider: 'vultr',
    createdAt: new Date().toISOString(),
    tag,
    plan: options.plan,
    osId,
    sshUser,
    regions: [...options.regions],
    instances: [],
    destroyWith: `swarm-fleet destroy --fleet ${fleetId}`,
  };

  try {
    for (let at = 0; at < options.count; at += 1) {
      throwIfAborted(options.signal);
      const region = options.regions[at % options.regions.length] as string;
      const label = `${FLEET_TAG}-${fleetId}-${String(at).padStart(3, '0')}`;
      const created = await options.client.createInstance({
        region,
        plan: options.plan,
        osId,
        label,
        hostname: label,
        tags: [FLEET_TAG, tag],
        sshKeyIds: [...options.sshKeyIds],
        userData,
      });
      fleet.instances.push({ id: created.id, label, region, ip: created.main_ip });
      // Rewritten per instance: a crash on the next one still leaves a file
      // naming everything created so far.
      await writeFleetState(stateDir, fleet);
      log('info', `created ${label} in ${region} (${created.id})`);
    }

    const ready = await waitForReady(options, fleet, log);
    fleet.instances = ready;
    await writeFleetState(stateDir, fleet);
    return fleet;
  } catch (error) {
    if (fleet.instances.length > 0) {
      log('warn', `provisioning failed; destroying ${fleet.instances.length} instance(s)`);
      // Best effort, and reported rather than thrown: the original failure is
      // the one worth surfacing, and a rollback error would hide it.
      for (const instance of fleet.instances) {
        try {
          await options.client.deleteInstance(instance.id);
          log('info', `destroyed ${instance.label}`);
        } catch (cleanupError) {
          log(
            'warn',
            `could not destroy ${instance.label} (${instance.id}): ${describe(cleanupError)} — ` +
              `run: swarm-fleet destroy --fleet ${fleetId}`,
          );
        }
      }
      await writeFleetState(stateDir, { ...fleet, instances: [] });
    }
    throw error;
  }
}

/**
 * Wait until every instance has an address and has finished cloud-init.
 *
 * Addresses come from one `GET /v2/instances?tag=…` for the whole fleet rather
 * than one call per instance: the API allows 30 calls a second and there is no
 * reason to spend forty of them on a poll tick.
 */
async function waitForReady(
  options: ProvisionOptions,
  fleet: ProvisionedFleet,
  log: ProvisionLog,
): Promise<ProvisionedInstance[]> {
  const timeoutMs = options.readyTimeoutMs ?? 10 * 60_000;
  const pollMs = options.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  const byId = new Map(fleet.instances.map((instance) => [instance.id, instance]));
  const ready = new Set<string>();
  let announcedAddresses = false;

  while (ready.size < byId.size) {
    throwIfAborted(options.signal);
    // `>=`: a deadline that has arrived has arrived, and a zero timeout must
    // not get one free round of ten-second ssh probes first.
    if (Date.now() >= deadline) {
      const missing = [...byId.values()]
        .filter((instance) => !ready.has(instance.id))
        .map((instance) => `${instance.label}${instance.ip === '' ? '' : ` (${instance.ip})`}`);
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${missing.join(', ')}`,
      );
    }

    const live = await options.client.listInstances(fleet.tag);
    const liveById = new Map(live.map((instance) => [instance.id, instance]));
    for (const [id, instance] of byId) {
      const current = liveById.get(id);
      if (current !== undefined && usableAddress(current)) {
        instance.ip = current.main_ip;
      }
    }

    const addressed = [...byId.values()].filter((instance) => instance.ip !== '' && instance.ip !== '0.0.0.0');
    if (!announcedAddresses && addressed.length === byId.size) {
      announcedAddresses = true;
      log('info', `all ${byId.size} instance(s) addressed; waiting for cloud-init`);
    }

    // Probed in parallel: ten sequential ssh handshakes at a two-second
    // timeout would make one poll tick longer than the interval.
    const probes = await Promise.all(
      addressed
        .filter((instance) => !ready.has(instance.id))
        .map(async (instance) => ({
          instance,
          state: await probeReady(instance.ip, options.sshUser ?? DEFAULT_SSH_USER),
        })),
    );
    for (const { instance, state } of probes) {
      if (state.kind === 'ready') {
        ready.add(instance.id);
        log('info', `${instance.label} ready (node ${state.detail})`);
      } else if (state.kind === 'failed') {
        throw new Error(`${instance.label} (${instance.ip}) failed cloud-init: ${state.detail}`);
      }
    }

    if (ready.size < byId.size) {
      await delay(pollMs, options.signal);
    }
  }
  return [...byId.values()];
}

function usableAddress(instance: VultrInstance): boolean {
  return instance.main_ip !== '' && instance.main_ip !== '0.0.0.0';
}

type ReadyState =
  | { kind: 'ready'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'pending'; detail: string };

/**
 * Ask a box whether cloud-init finished.
 *
 * Reads the failure sentinel first: a box that reports both is a box whose
 * script failed and then somehow wrote `ready`, and the failure is the answer
 * worth acting on.
 */
export async function probeReady(ip: string, user: string): Promise<ReadyState> {
  const script =
    'if [ -f /var/lib/swarm-fleet/failed ]; then ' +
    'printf "failed:"; cat /var/lib/swarm-fleet/failed; ' +
    'elif [ -f /var/lib/swarm-fleet/ready ]; then ' +
    'printf "ready:"; cat /var/lib/swarm-fleet/ready; ' +
    'else printf "pending:"; fi';

  const result = await runSsh(ip, user, script, 10_000);
  if (result.code !== 0) {
    // sshd not up yet, or the host key changed under a recycled address. Both
    // are "not ready", not "broken": the deadline is what ends this.
    return { kind: 'pending', detail: result.stderr.trim().slice(0, 120) };
  }
  const output = result.stdout.trim();
  if (output.startsWith('ready:')) {
    return { kind: 'ready', detail: output.slice('ready:'.length).trim() };
  }
  if (output.startsWith('failed:')) {
    return { kind: 'failed', detail: output.slice('failed:'.length).trim() };
  }
  return { kind: 'pending', detail: output };
}

interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSsh(ip: string, user: string, script: string, timeoutMs: number): Promise<SshResult> {
  const args = [
    ...sshArgs({ host: ip, user, ephemeralHost: true }),
    '-o',
    `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`,
    '--',
    `sh -c ${singleQuote(script)}`,
  ];
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Single-quote for a POSIX shell, the same way `deploy` does. */
export function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------ teardown

export interface DestroyOptions {
  client: VultrClient;
  /** A fleet id, or every instance carrying the rig's tag when absent. */
  fleetId?: string | undefined;
  stateDir?: string | undefined;
  log?: ProvisionLog | undefined;
}

export interface DestroyResult {
  destroyed: ProvisionedInstance[];
  failed: { instance: ProvisionedInstance; error: string }[];
}

/**
 * Destroy a fleet, asking the provider what it consists of.
 *
 * The provider is the source of truth on purpose. A fleet whose state file was
 * lost, or that was created from another machine, is still destroyable — which
 * is the whole reason the tag exists.
 */
export async function destroyFleet(options: DestroyOptions): Promise<DestroyResult> {
  const log = options.log ?? (() => undefined);
  const tag = options.fleetId === undefined ? FLEET_TAG : fleetTag(options.fleetId);
  const live = await options.client.listInstances(tag);

  const result: DestroyResult = { destroyed: [], failed: [] };
  for (const instance of live) {
    const record: ProvisionedInstance = {
      id: instance.id,
      label: instance.label,
      region: instance.region,
      ip: instance.main_ip,
    };
    try {
      const outcome = await options.client.deleteInstance(instance.id);
      result.destroyed.push(record);
      log('info', `${outcome} ${instance.label || instance.id} (${instance.region})`);
    } catch (error) {
      result.failed.push({ instance: record, error: describe(error) });
      log('warn', `could not destroy ${instance.label || instance.id}: ${describe(error)}`);
    }
  }

  if (options.fleetId !== undefined && result.failed.length === 0) {
    const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
    const stored = await readFleetState(stateDir, options.fleetId);
    if (stored !== undefined) {
      await writeFleetState(stateDir, { ...stored, instances: [] });
    }
  }
  return result;
}

// --------------------------------------------------------------------- state

export function agentTargetsFor(fleet: ProvisionedFleet): AgentTarget[] {
  return fleet.instances.map((instance) => ({
    host: instance.ip,
    name: instance.label,
    user: fleet.sshUser,
    ephemeralHost: true,
    weight: 1,
  }));
}

export async function writeFleetState(stateDir: string, fleet: ProvisionedFleet): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, `${fleet.fleetId}.json`);
  await writeFile(file, `${JSON.stringify(fleet, null, 2)}\n`, 'utf8');
  return file;
}

export async function readFleetState(
  stateDir: string,
  fleetId: string,
): Promise<ProvisionedFleet | undefined> {
  try {
    const raw = await readFile(path.join(stateDir, `${fleetId}.json`), 'utf8');
    return ProvisionedFleet.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Newest first, so the fleet someone just made is the one they mean. */
export async function listFleetStates(stateDir: string): Promise<ProvisionedFleet[]> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return [];
  }
  const out: ProvisionedFleet[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort().reverse()) {
    const fleet = await readFleetState(stateDir, name.slice(0, -'.json'.length));
    if (fleet !== undefined) {
      out.push(fleet);
    }
  }
  return out;
}

// ------------------------------------------------------------------- helpers

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error('provisioning aborted');
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('provisioning aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
