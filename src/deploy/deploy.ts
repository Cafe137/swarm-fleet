/**
 * Getting the viewer, and the agent that runs it, onto the machines.
 *
 * Before this existed, a remote run meant installing the fleet package on every
 * box by hand and copying `weeb-3-rs-hls` to the *same absolute path* on each
 * one, because `ViewerSpec.binary` is a single string sent to every agent.
 * Preflight then refused the run if any host had missed the memo, which was the
 * only thing standing between a typo and a fleet measuring two different
 * builds.
 *
 * So both artefacts are content-addressed by their own sha256 and land under a
 * fixed root: `<root>/bin/weeb-3-rs-hls-<sha12>` and `<root>/agent-<sha12>/`.
 * That gives three properties worth the arithmetic:
 *
 *   - the path is identical on every machine, including the controller's own,
 *     so one `binary` string is correct everywhere;
 *   - a host that already has the right bytes is skipped, so re-running a
 *     scenario against twenty machines uploads nothing;
 *   - two builds cannot collide, so an interrupted run leaves no half-written
 *     binary that the next run would happily execute.
 *
 * The root is under `/tmp` on purpose. A load-test viewer wants a cold cache
 * every run, nothing here is worth keeping, and `/tmp` is writable without
 * asking anybody's permission on every box we might borrow.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentTarget } from '../scenario.js';
import { sshArgs } from '../transport/ssh.js';
import { MOCK_BINARY } from '../viewer/spawn.js';
import { readBinaryTarget, runsOn, type BinaryTarget } from './elf.js';

export const DEFAULT_DEPLOY_ROOT = '/tmp/swarm-fleet';
/** The agent is Node; below this it is not the Node this code was written for. */
export const MIN_NODE_MAJOR = 20;

export interface DeployPlan {
  root: string;
  /** Local path to the viewer binary being shipped. */
  binarySource: string;
  binarySha256: string;
  binaryRemotePath: string;
  binaryTarget: BinaryTarget | undefined;
  /** Local tarball holding the agent's compiled JS and its one dependency. */
  agentArchive: string;
  agentSha256: string;
  agentRemoteDir: string;
  agentCommand: string;
}

export interface RemoteFacts {
  unameS: string;
  unameM: string;
  nodeVersion: string | undefined;
}

export interface HostOutcome {
  name: string;
  host: string;
  facts: RemoteFacts;
  binary: 'uploaded' | 'present';
  agent: 'uploaded' | 'present';
  uploadedBytes: number;
  ms: number;
}

export type DeployLog = (level: 'info' | 'warn', message: string) => void;

/**
 * Where the artefacts live, from their hashes alone.
 *
 * Pure, and the same on every machine: the whole point of content-addressing
 * them is that one `binary` string is correct for the controller and for
 * twenty hosts at once.
 */
export function deployPaths(
  root: string,
  binarySha256: string,
  agentSha256: string,
): { binaryRemotePath: string; agentRemoteDir: string; agentCommand: string } {
  const agentRemoteDir = `${root}/agent-${agentSha256.slice(0, 12)}`;
  return {
    binaryRemotePath: `${root}/bin/weeb-3-rs-hls-${binarySha256.slice(0, 12)}`,
    agentRemoteDir,
    agentCommand: agentCommandFor(agentRemoteDir),
  };
}

/**
 * How the agent is started, and why it is not just `node cli.js`.
 *
 * One viewer holds 200 peer connections, and a stock Ubuntu box hands an ssh
 * session a *soft* file-descriptor limit of 1024 — enough for four viewers —
 * against a hard limit of 1,048,576. So the fleet's most common failure was a
 * box being able to run 1,000 viewers and refusing at 4, presenting as dials
 * failing, which reads as a network problem rather than as a limit.
 *
 * Raising a soft limit up to the hard limit needs no privilege and no system
 * configuration, so the agent does it to itself before exec'ing, and the
 * viewers inherit it. Preflight still reads and reports the *effective* limit
 * afterwards, so this makes the check pass by fixing the problem rather than by
 * hiding it — and on a box whose hard limit really is 1024, the check still
 * refuses the run.
 */
export function agentCommandFor(agentRemoteDir: string): string {
  const node = `exec node ${agentRemoteDir}/dist/cli.js agent --stdio`;
  return `sh -c 'ulimit -n "$(ulimit -Hn)" 2>/dev/null || true; ${node}'`;
}

/**
 * Build what needs building and work out where it all goes.
 *
 * Hashing the binary is not free on a slow disk, so it happens once here rather
 * than once per host.
 */
export async function planDeployment(options: {
  binary: string;
  root?: string | undefined;
  log?: DeployLog | undefined;
}): Promise<DeployPlan> {
  const log = options.log ?? ((): void => undefined);
  const root = options.root ?? DEFAULT_DEPLOY_ROOT;

  // `mock` is the built-in fake viewer, which lives inside the agent bundle
  // rather than beside it. Deploying it means deploying the agent, and a
  // cross-machine mock run is the cheapest way to prove the fleet's plumbing
  // works before a real binary exists for those hosts.
  if (options.binary === MOCK_BINARY) {
    const mockArchive = await buildAgentArchive(log);
    const paths = deployPaths(root, '', mockArchive.sha256);
    return {
      root,
      binarySource: MOCK_BINARY,
      binarySha256: '',
      binaryTarget: undefined,
      agentArchive: mockArchive.path,
      agentSha256: mockArchive.sha256,
      ...paths,
      binaryRemotePath: MOCK_BINARY,
    };
  }

  const binarySource = path.resolve(options.binary);
  const info = await stat(binarySource).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new Error(`--binary ${binarySource} is not a file, so there is nothing to deploy`);
  }
  const binarySha256 = await sha256File(binarySource);
  const binaryTarget = await readBinaryTarget(binarySource);
  if (binaryTarget === undefined) {
    log(
      'warn',
      `${path.basename(binarySource)} is not an ELF binary, so it cannot be checked against ` +
        'the hosts it is being sent to',
    );
  }

  const archive = await buildAgentArchive(log);

  return {
    root,
    binarySource,
    binarySha256,
    binaryTarget,
    agentArchive: archive.path,
    agentSha256: archive.sha256,
    ...deployPaths(root, binarySha256, archive.sha256),
  };
}

/**
 * Deploy to every non-local target, in parallel.
 *
 * Parallel because twenty hosts sequentially is twenty round trips of latency
 * for no reason, and because a deploy is idempotent: nothing here depends on
 * the order or on another host's outcome.
 */
export async function deployFleet(
  targets: readonly AgentTarget[],
  plan: DeployPlan,
  log: DeployLog = () => undefined,
): Promise<HostOutcome[]> {
  const remote = targets.filter((target) => target.host !== 'local');
  const outcomes = await Promise.all(
    remote.map((target) => deployToHost(target, plan, log)),
  );
  if (targets.some((target) => target.host === 'local')) {
    await installLocally(plan);
    log('info', `local: ${plan.binaryRemotePath}`);
  }
  return outcomes;
}

/**
 * The controller's own copy.
 *
 * A fleet with both local and remote agents still has to name one binary path,
 * so the local machine gets the same content-addressed file. The copy is
 * skipped when it is already there, which also means a `--deploy` run against
 * `--agent local` alone costs one hash and one copy.
 */
export async function installLocally(plan: DeployPlan): Promise<void> {
  if (plan.binaryRemotePath === MOCK_BINARY) {
    return;
  }
  const existing = await stat(plan.binaryRemotePath).catch(() => undefined);
  if (existing?.isFile() === true) {
    return;
  }
  await mkdir(path.dirname(plan.binaryRemotePath), { recursive: true });
  const staging = `${plan.binaryRemotePath}.part`;
  await copyFile(plan.binarySource, staging);
  await chmod(staging, 0o755);
  await rename(staging, plan.binaryRemotePath);
}

async function deployToHost(
  target: AgentTarget,
  plan: DeployPlan,
  log: DeployLog,
): Promise<HostOutcome> {
  const name = target.name ?? target.host;
  const startedAt = Date.now();
  const facts = await remoteFacts(target);

  if (facts.nodeVersion === undefined) {
    throw new Error(
      `${name}: no \`node\` on PATH. The agent is Node ${MIN_NODE_MAJOR}+; install it, or ` +
        'give this agent a `command` that points at one.',
    );
  }
  const major = Number(facts.nodeVersion.replace(/^v/, '').split('.')[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `${name}: node ${facts.nodeVersion} is below the ${MIN_NODE_MAJOR} the agent needs`,
    );
  }
  if (plan.binaryTarget !== undefined && !runsOn(plan.binaryTarget, facts.unameS, facts.unameM)) {
    throw new Error(
      `${name} is ${facts.unameS}/${facts.unameM} and the binary is ` +
        `${plan.binaryTarget.machine} ${plan.binaryTarget.bits}-bit ELF: it would fail as ` +
        '`exec format error` one viewer at a time. Build for this host, or use the Linux ' +
        'AMD64 artifact from CI (`--from-github`).',
    );
  }

  let uploadedBytes = 0;

  // Content-addressed, so a matching hash *is* a matching binary. Hashing an
  // 8 MB file remotely costs less than uploading it.
  const remoteHash =
    plan.binaryRemotePath === MOCK_BINARY
      ? plan.binarySha256
      : await sha256Remote(target, plan.binaryRemotePath);
  let binary: HostOutcome['binary'] = 'present';
  if (remoteHash !== plan.binarySha256) {
    if (remoteHash !== undefined) {
      log('warn', `${name}: ${plan.binaryRemotePath} has the wrong contents; replacing it`);
    }
    await uploadBinary(target, plan);
    const verified = await sha256Remote(target, plan.binaryRemotePath);
    if (verified !== plan.binarySha256) {
      throw new Error(
        `${name}: uploaded binary hashes ${verified ?? 'nothing'}, expected ` +
          `${plan.binarySha256}. The transfer was truncated.`,
      );
    }
    binary = 'uploaded';
    uploadedBytes += (await stat(plan.binarySource)).size;
    log('info', `${name}: viewer -> ${plan.binaryRemotePath}`);
  }

  // The agent's marker is written last, so an interrupted unpack is not
  // mistaken for a finished one.
  const agentReady = await remoteExists(target, `${plan.agentRemoteDir}/.ready`);
  let agent: HostOutcome['agent'] = 'present';
  if (!agentReady) {
    await uploadAgent(target, plan);
    agent = 'uploaded';
    uploadedBytes += (await stat(plan.agentArchive)).size;
    log('info', `${name}: agent -> ${plan.agentRemoteDir}`);
  }

  return {
    name,
    host: target.host,
    facts,
    binary,
    agent,
    uploadedBytes,
    ms: Date.now() - startedAt,
  };
}

// ------------------------------------------------------------------- remote

async function remoteFacts(target: AgentTarget): Promise<RemoteFacts> {
  const result = await runSsh(
    target,
    'uname -s; uname -m; (node --version 2>/dev/null || echo none)',
  );
  if (result.code !== 0) {
    throw new Error(
      `${target.name ?? target.host}: ssh failed (${result.code}): ${result.stderr.trim() || 'no output'}`,
    );
  }
  const [unameS = '', unameM = '', node = 'none'] = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    unameS,
    unameM,
    nodeVersion: node === 'none' ? undefined : node,
  };
}

/** `sha256sum` on Linux, `shasum` on darwin, nothing at all if the file is absent. */
async function sha256Remote(target: AgentTarget, file: string): Promise<string | undefined> {
  const quoted = singleQuote(file);
  const result = await runSsh(
    target,
    `if [ -f ${quoted} ]; then sha256sum ${quoted} 2>/dev/null || shasum -a 256 ${quoted}; fi`,
  );
  const hash = result.stdout.trim().split(/\s+/)[0];
  return hash === undefined || hash.length !== 64 ? undefined : hash;
}

async function remoteExists(target: AgentTarget, file: string): Promise<boolean> {
  const result = await runSsh(target, `test -e ${singleQuote(file)} && echo yes`);
  return result.stdout.trim() === 'yes';
}

async function uploadBinary(target: AgentTarget, plan: DeployPlan): Promise<void> {
  const final = singleQuote(plan.binaryRemotePath);
  // No pid in the staging name: it is derived from the content hash, so two
  // deploys racing on one host are two deploys of identical bytes, and `mv` is
  // atomic.
  const staging = singleQuote(`${plan.binaryRemotePath}.part`);
  const script =
    `mkdir -p ${singleQuote(`${plan.root}/bin`)} && cat > ${staging} && ` +
    `chmod 755 ${staging} && mv -f ${staging} ${final}`;
  const result = await runSsh(target, script, plan.binarySource);
  if (result.code !== 0) {
    throw new Error(
      `${target.name ?? target.host}: uploading the viewer failed: ${result.stderr.trim()}`,
    );
  }
}

async function uploadAgent(target: AgentTarget, plan: DeployPlan): Promise<void> {
  const dir = singleQuote(plan.agentRemoteDir);
  const script =
    `rm -rf ${dir} && mkdir -p ${dir} && tar xzf - -C ${dir} && ` +
    `touch ${singleQuote(`${plan.agentRemoteDir}/.ready`)}`;
  const result = await runSsh(target, script, plan.agentArchive);
  if (result.code !== 0) {
    throw new Error(
      `${target.name ?? target.host}: unpacking the agent failed: ${result.stderr.trim()}`,
    );
  }
}

interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * One `ssh` invocation running one shell script, optionally with a local file
 * on its stdin.
 *
 * ssh joins its remaining arguments with spaces and hands the result to the
 * remote login shell, so a script has to arrive as a single already-quoted
 * argument or the shell re-splits it on whitespace. Everything interpolated
 * into these scripts goes through `singleQuote`.
 */
function runSsh(target: AgentTarget, script: string, stdinFile?: string): Promise<SshResult> {
  const args = [...sshArgs(target), '--', `sh -c ${singleQuote(script)}`];
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdinFile === undefined) {
      child.stdin.end();
    } else {
      createReadStream(stdinFile).pipe(child.stdin);
    }
  });
}

/** POSIX single-quoting: the only escape inside single quotes is ending them. */
export function singleQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// -------------------------------------------------------------- the archive

/**
 * The agent, as a half-megabyte tarball.
 *
 * This is the answer to "do I have to install the fleet on every machine": no,
 * but something has to carry the code, and the smallest honest something is the
 * compiled `dist` plus the one runtime dependency the package has. Type
 * declarations and source maps are left out — nothing on the far side reads
 * them, and they are most of the weight.
 *
 * Node resolves `zod` from `<dir>/dist/..` upwards, so `node_modules/zod` at
 * the archive root is exactly where the unpacked tree needs it.
 */
/** What travels, and what is left out because nothing on the far side reads it. */
const ARCHIVE_TREES = ['dist', 'node_modules/zod', 'package.json'];
const ARCHIVE_EXCLUDES = ['*.map', '*.d.ts', '*.d.mts', '*.d.cts'];

export async function buildAgentArchive(
  log: DeployLog = () => undefined,
): Promise<{ path: string; sha256: string }> {
  const root = packageRoot();
  if (await distIsStale(root)) {
    log('info', 'compiling the agent (dist is older than src)');
    await run('npm', ['run', 'build'], root);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-agent-'));
  const archive = path.join(dir, 'agent.tar.gz');
  await run(
    'tar',
    [
      'czf',
      archive,
      ...ARCHIVE_EXCLUDES.flatMap((pattern) => ['--exclude', pattern]),
      '-C',
      root,
      ...ARCHIVE_TREES,
    ],
    root,
  );
  return { path: archive, sha256: await hashArchiveContents(root) };
}

/**
 * The agent's identity: a hash of what is inside the archive, not of the
 * archive.
 *
 * gzip stamps its output with the current time, so hashing the tarball gives a
 * different answer every build and every host would re-download an identical
 * agent on every deploy. Hashing the file list and each file's contents instead
 * makes the identity describe the code, which is what the content-addressed
 * path is claiming — and it means two developers' machines produce the same
 * agent id for the same commit.
 */
async function hashArchiveContents(root: string): Promise<string> {
  const files: string[] = [];
  for (const tree of ARCHIVE_TREES) {
    files.push(...(await filesIn(path.join(root, tree))));
  }
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    // The path matters as much as the bytes: a file that moved is a different
    // tree, even if every byte in it is unchanged.
    hash.update(path.relative(root, file));
    hash.update('\0');
    hash.update(await sha256File(file));
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function filesIn(target: string): Promise<string[]> {
  const info = await stat(target).catch(() => undefined);
  if (info === undefined) {
    return [];
  }
  if (info.isFile()) {
    return excluded(target) ? [] : [target];
  }
  const out: string[] = [];
  for (const item of await readdir(target, { withFileTypes: true })) {
    out.push(...(await filesIn(path.join(target, item.name))));
  }
  return out;
}

/** The same patterns `tar` is given, so the hash describes what is shipped. */
function excluded(file: string): boolean {
  return ARCHIVE_EXCLUDES.some((pattern) => file.endsWith(pattern.replace('*', '')));
}

/** The fleet package root, from either `src/deploy/` or `dist/deploy/`. */
function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

async function distIsStale(root: string): Promise<boolean> {
  const entry = await stat(path.join(root, 'dist', 'cli.js')).catch(() => undefined);
  if (entry === undefined) {
    return true;
  }
  return (await newestMtime(path.join(root, 'src'))) > entry.mtimeMs;
}

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      newest = Math.max(newest, await newestMtime(full));
      continue;
    }
    const info = await stat(full).catch(() => undefined);
    if (info !== undefined) {
      newest = Math.max(newest, info.mtimeMs);
    }
  }
  return newest;
}

export async function discardArchive(plan: DeployPlan): Promise<void> {
  await rm(path.dirname(plan.agentArchive), { recursive: true, force: true });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
