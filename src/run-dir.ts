/** Run directories: one per run, self-describing, no parser required. */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function runId(label: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  return `${stamp}_${label.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

export async function createRunDir(runsDir: string, id: string): Promise<string> {
  const dir = path.resolve(runsDir, id);
  await mkdir(path.join(dir, 'viewers'), { recursive: true });
  return dir;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, replacer, 2)}\n`, 'utf8');
}

/** `undefined` survives as an absent key; NaN and Infinity become null. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}
