/**
 * Getting the operator's public key onto the provider.
 *
 * `README` promises a remote machine needs nothing but an ssh key and Node, and
 * a provisioned machine has to get that key at creation time — there is no
 * other way in. So this finds the key the operator already uses, matches it
 * against what the account holds, and uploads it only if it is genuinely new.
 *
 * Matching is on the key material rather than the name, because names collide
 * across machines and key bodies do not: two laptops both calling their key
 * `swarm-fleet` would otherwise fight over one Vultr entry and lock one of them
 * out of every box it provisioned.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VultrClient, VultrSshKey } from './vultr.js';

/** Tried in order. Ed25519 first: it is what a key made this decade looks like. */
export const DEFAULT_KEY_PATHS = [
  '.ssh/id_ed25519.pub',
  '.ssh/id_ecdsa.pub',
  '.ssh/id_rsa.pub',
] as const;

export interface LocalKey {
  path: string;
  material: string;
}

export async function findLocalPublicKey(explicit?: string): Promise<LocalKey> {
  const candidates =
    explicit === undefined
      ? DEFAULT_KEY_PATHS.map((name) => path.join(os.homedir(), name))
      : [explicit.startsWith('~/') ? path.join(os.homedir(), explicit.slice(2)) : explicit];

  for (const candidate of candidates) {
    try {
      const material = (await readFile(candidate, 'utf8')).trim();
      if (material.length > 0) {
        return { path: candidate, material };
      }
    } catch {
      // Next candidate. A missing default key is ordinary; a missing explicit
      // one falls out of the loop and is reported below.
    }
  }
  throw new Error(
    explicit === undefined
      ? `no ssh public key found (looked for ${DEFAULT_KEY_PATHS.join(', ')} under ${os.homedir()}); ` +
        'pass --ssh-key <path/to/key.pub>'
      : `ssh public key not readable: ${explicit}`,
  );
}

/**
 * Two ssh public keys are the same key when their type and base64 body match.
 *
 * The trailing comment is whatever the generating machine put there — usually
 * `user@host` — and is not part of the key. Comparing whole lines would upload
 * a duplicate every time an operator moved machines.
 */
export function sameKey(left: string, right: string): boolean {
  const normalise = (value: string): string => value.trim().split(/\s+/).slice(0, 2).join(' ');
  return normalise(left) === normalise(right);
}

export interface ResolvedSshKey {
  id: string;
  name: string;
  localPath: string;
  created: boolean;
}

export async function ensureSshKey(
  client: VultrClient,
  options: { path?: string | undefined; name?: string | undefined } = {},
): Promise<ResolvedSshKey> {
  const local = await findLocalPublicKey(options.path);
  const existing: VultrSshKey[] = await client.listSshKeys();
  const match = existing.find((key) => sameKey(key.ssh_key, local.material));
  if (match !== undefined) {
    return { id: match.id, name: match.name, localPath: local.path, created: false };
  }

  const name = options.name ?? `swarm-fleet-${os.hostname()}`;
  const created = await client.createSshKey(name, local.material);
  return { id: created.id, name: created.name, localPath: local.path, created: true };
}
