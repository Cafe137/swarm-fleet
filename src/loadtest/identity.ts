/**
 * The name a participant keeps.
 *
 * The server hands out an anonymous name — `brave-otter-418` — and the obvious
 * implementation forgets it when the process ends. That is wrong for the event
 * this is built for: somebody's laptop sleeps, somebody quits to take a call,
 * somebody's viewer is killed and they start it again, and each time they would
 * appear on the leaderboard as a new person. The totals would then count one
 * participant three times and the leaderboard would fill with ghosts.
 *
 * So the session id is written next to the rest of the tool's cache, keyed by
 * backend, and offered back on the next join. The server decides whether to
 * honour it; this side only remembers.
 *
 * Nothing here may throw. A read-only home directory is a reason to be
 * anonymous twice, not a reason to fail to take part.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface StoredIdentity {
  sessionId: string;
  name: string;
}

interface IdentityFile {
  /** Keyed by backend origin, so a rehearsal server does not shadow the real one. */
  servers: Record<string, StoredIdentity>;
}

export function configRoot(): string {
  const base =
    process.platform === 'win32'
      ? (process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : (process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'));
  return path.join(base, 'swarm-loadtest');
}

function identityPath(): string {
  return path.join(configRoot(), 'session.json');
}

export async function loadIdentity(server: string): Promise<StoredIdentity | undefined> {
  try {
    const parsed = JSON.parse(await readFile(identityPath(), 'utf8')) as IdentityFile;
    const found = parsed.servers?.[server];
    return typeof found?.sessionId === 'string' && typeof found?.name === 'string'
      ? found
      : undefined;
  } catch {
    return undefined;
  }
}

export async function saveIdentity(server: string, identity: StoredIdentity): Promise<void> {
  try {
    let file: IdentityFile = { servers: {} };
    try {
      file = JSON.parse(await readFile(identityPath(), 'utf8')) as IdentityFile;
      if (typeof file.servers !== 'object' || file.servers === null) {
        file = { servers: {} };
      }
    } catch {
      // No file yet, or an unreadable one. Either way it is about to be written.
    }
    file.servers[server] = identity;
    await mkdir(configRoot(), { recursive: true });
    await writeFile(identityPath(), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  } catch {
    // Anonymous again next time. Not worth interrupting a load test for.
  }
}
