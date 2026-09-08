import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildAgentArchive,
  deployPaths,
  installLocally,
  singleQuote,
  type DeployPlan,
} from './deploy.js';
import { readBinaryTarget, runsOn } from './elf.js';

test('artefact paths come from the hashes, so every machine agrees on them', () => {
  const paths = deployPaths('/tmp/swarm-fleet', 'a'.repeat(64), 'b'.repeat(64));
  assert.equal(paths.binaryRemotePath, '/tmp/swarm-fleet/bin/weeb-3-rs-hls-aaaaaaaaaaaa');
  assert.equal(paths.agentRemoteDir, '/tmp/swarm-fleet/agent-bbbbbbbbbbbb');
  // The agent raises its own descriptor limit before exec'ing node: a stock
  // Ubuntu box gives an ssh session 1024, which is four viewers at 200 peers.
  assert.equal(
    paths.agentCommand,
    'sh -c \'ulimit -n "$(ulimit -Hn)" 2>/dev/null || true; ' +
      'exec node /tmp/swarm-fleet/agent-bbbbbbbbbbbb/dist/cli.js agent --stdio\'',
  );

  // Two builds cannot land on one path, which is what stops a fleet from
  // running a mixture and reporting one number.
  const other = deployPaths('/tmp/swarm-fleet', 'c'.repeat(64), 'b'.repeat(64));
  assert.notEqual(other.binaryRemotePath, paths.binaryRemotePath);
});

test('remote scripts survive the shell twice', () => {
  // ssh hands the argument to a login shell, which parses it, and the script
  // inside then runs under `sh -c`. A path with a space in it has to come out
  // the far side intact.
  assert.equal(singleQuote('/tmp/a b'), "'/tmp/a b'");
  assert.equal(singleQuote("it's"), "'it'\\''s'");
  assert.equal(singleQuote('$(rm -rf /)'), "'$(rm -rf /)'");
});

test('a local install is atomic and idempotent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-deploy-test-'));
  const source = path.join(dir, 'viewer');
  await writeFile(source, 'binary contents');
  const plan: DeployPlan = {
    root: dir,
    binarySource: source,
    binarySha256: 'f'.repeat(64),
    binaryTarget: undefined,
    agentArchive: path.join(dir, 'unused.tar.gz'),
    agentSha256: 'e'.repeat(64),
    ...deployPaths(dir, 'f'.repeat(64), 'e'.repeat(64)),
  };

  await installLocally(plan);
  assert.equal(await readFile(plan.binaryRemotePath, 'utf8'), 'binary contents');
  const mode = (await stat(plan.binaryRemotePath)).mode & 0o777;
  assert.equal(mode & 0o111, 0o111, 'the deployed viewer has to be executable');
  // No staging file left behind, and a second call is a no-op rather than an error.
  await assert.rejects(stat(`${plan.binaryRemotePath}.part`));
  await installLocally(plan);
});

test('an ELF header says which machines a binary will run on', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-elf-test-'));
  const file = path.join(dir, 'fake');
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2; // 64-bit
  header[5] = 1; // little endian
  header[7] = 0; // SysV
  header.writeUInt16LE(0x3e, 18); // x86-64
  await writeFile(file, header);

  const target = await readBinaryTarget(file);
  assert.deepEqual(target, { machine: 'x86-64', bits: 64, sysv: true });
  assert.equal(runsOn(target as NonNullable<typeof target>, 'Linux', 'x86_64'), true);
  assert.equal(runsOn(target as NonNullable<typeof target>, 'Linux', 'amd64'), true);
  // The failure this exists to prevent: an x86 build sent to arm boxes.
  assert.equal(runsOn(target as NonNullable<typeof target>, 'Linux', 'aarch64'), false);
  assert.equal(runsOn(target as NonNullable<typeof target>, 'Darwin', 'x86_64'), false);
});

test('a Mach-O binary is not an ELF binary, and is not mistaken for one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-elf-test-'));
  const file = path.join(dir, 'macho');
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0xcffaedfe, 0);
  await writeFile(file, header);
  assert.equal(await readBinaryTarget(file), undefined);
});

test('the agent id describes its contents, not the tarball', async () => {
  // gzip stamps the current time into its output, so two archives of an
  // identical tree built a second apart do not share a byte pattern —
  // confirmed with `tar czf` twice over one directory. Hashing the archive
  // therefore gave a fresh id on every build, and every host re-downloaded an
  // identical agent on every deploy. The id has to describe the code.
  const first = await buildAgentArchive();
  const second = await buildAgentArchive();
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(first.path, second.path, 'each build gets its own staging directory');
});
