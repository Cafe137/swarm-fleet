/**
 * The remote deploy path, with `ssh` shimmed to a local shell.
 *
 * Everything here except the network hop is what runs against a real host: the
 * same scripts, the same double round of shell quoting, the same remote hashing
 * and unpacking. The shim is a shell script named `ssh` that takes its last
 * argument and hands it to `sh -c`, which is precisely what a real login shell
 * does with the command string ssh sends it — so a quoting bug fails here
 * rather than at 200-viewer launch time.
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentTarget } from '../scenario.js';
import { deployFleet, planDeployment, sha256File } from './deploy.js';

async function shimSsh(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-ssh-shim-'));
  const shim = path.join(dir, 'ssh');
  await writeFile(
    shim,
    ['#!/bin/sh', '# The command string is ssh\'s last argument.', 'for a in "$@"; do last="$a"; done', 'exec /bin/sh -c "$last"', ''].join('\n'),
  );
  await chmod(shim, 0o755);
  return dir;
}

async function withShim<T>(body: () => Promise<T>): Promise<T> {
  const dir = await shimSsh();
  const original = process.env['PATH'];
  process.env['PATH'] = `${dir}:${original ?? ''}`;
  try {
    return await body();
  } finally {
    process.env['PATH'] = original;
  }
}

const target: AgentTarget = { host: 'fake-host', weight: 1 };

test('a deploy lands both artefacts, verifies them, and skips a host that has them', async () => {
  await withShim(async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-remote-test-'));
    const binary = path.join(work, 'weeb-3-rs-hls');
    await writeFile(binary, 'not really a viewer, but it hashes like one');
    const plan = await planDeployment({ binary, root: path.join(work, 'root') });

    const first = await deployFleet([target], plan);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.binary, 'uploaded');
    assert.equal(first[0]?.agent, 'uploaded');
    assert.ok((first[0]?.uploadedBytes ?? 0) > 0);

    // The bytes that arrived are the bytes that were sent.
    assert.equal(await sha256File(plan.binaryRemotePath), plan.binarySha256);
    assert.equal((await stat(plan.binaryRemotePath)).mode & 0o111, 0o111);

    // The agent is unpacked and runnable: its entry point and its one
    // dependency are both there, and the marker says the unpack finished.
    await stat(path.join(plan.agentRemoteDir, '.ready'));
    await stat(path.join(plan.agentRemoteDir, 'dist', 'cli.js'));
    await stat(path.join(plan.agentRemoteDir, 'node_modules', 'zod', 'package.json'));
    assert.match(plan.agentCommand, /ulimit -n .*exec node .*\/dist\/cli\.js agent --stdio'$/);

    // Twenty machines re-running a scenario should upload nothing.
    const second = await deployFleet([target], plan);
    assert.equal(second[0]?.binary, 'present');
    assert.equal(second[0]?.agent, 'present');
    assert.equal(second[0]?.uploadedBytes, 0);
  });
});

test('a remote file with the wrong contents is replaced, not trusted', async () => {
  await withShim(async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-remote-test-'));
    const binary = path.join(work, 'weeb-3-rs-hls');
    await writeFile(binary, 'the real thing');
    const plan = await planDeployment({ binary, root: path.join(work, 'root') });
    await deployFleet([target], plan);

    // An interrupted transfer, or someone else's build under our name.
    await writeFile(plan.binaryRemotePath, 'truncated');
    const warnings: string[] = [];
    const again = await deployFleet([target], plan, (level, message) => {
      if (level === 'warn') {
        warnings.push(message);
      }
    });
    assert.equal(again[0]?.binary, 'uploaded');
    assert.equal(await readFile(plan.binaryRemotePath, 'utf8'), 'the real thing');
    assert.match(warnings.join(' '), /wrong contents/);
  });
});

test('paths with a space in them survive both shells', async () => {
  await withShim(async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet remote test-'));
    const binary = path.join(work, 'weeb-3-rs-hls');
    await writeFile(binary, 'contents');
    const plan = await planDeployment({ binary, root: path.join(work, 'deploy root') });

    const outcome = await deployFleet([target], plan);
    assert.equal(outcome[0]?.binary, 'uploaded');
    assert.equal(await sha256File(plan.binaryRemotePath), plan.binarySha256);
    await stat(path.join(plan.agentRemoteDir, '.ready'));
  });
});
