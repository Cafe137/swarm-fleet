/**
 * Fetching the viewer from CI instead of from someone's laptop.
 *
 * The rig's numbers are only comparable if every viewer in every run is the
 * same build, and a binary built by hand on a Mac cannot even execute on the
 * Linux boxes a real fleet runs on. So the trustworthy source of
 * `weeb-3-rs-hls` is the Linux AMD64 artifact CI produces per commit, and
 * `deploy --from-github` is how it gets here.
 *
 * There are two ways in, because there are two kinds of artefact. A **workflow
 * artifact** is not anonymously downloadable — the REST endpoint needs a token —
 * so `gh` does that talking rather than this file reimplementing a token search
 * badly. A **release asset** needs no token at all, which is the whole reason
 * CI publishes a rolling `nightly` prerelease, so that path is plain HTTPS
 * against the REST API and works on a machine with no `gh` and nobody logged in.
 *
 * Without `gh`, `--from-github` therefore falls back to the newest release
 * rather than failing: the common case — deploy the current build to some boxes
 * — should not require installing a CLI and authenticating first.
 *
 * The commit is carried through into the run: `preflight` records the binary's
 * sha256 and every agent must report the same one, so a run directory says
 * exactly which build produced its numbers.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256File } from './deploy.js';
import { artifactFor, assetFor, type ViewerPlatform } from './platform.js';

export const DEFAULT_REPO = 'Cafe137/weeb-3-rs-hls';
export const DEFAULT_WORKFLOW = 'build.yml';
/** The artifact CI uploads, and the release asset it publishes. */
export const DEFAULT_ARTIFACT = 'weeb-3-rs-hls-linux-amd64';
export const BINARY_NAME = 'weeb-3-rs-hls';

export interface GithubSource {
  repo?: string | undefined;
  workflow?: string | undefined;
  artifact?: string | undefined;
  /** A release tag. Mutually exclusive with `commit`; `latest` release if empty. */
  tag?: string | undefined;
  /** A commit sha, resolved to that commit's successful build run. */
  commit?: string | undefined;
  /** A workflow run id, when you already know exactly which one you want. */
  runId?: string | undefined;
}

export interface FetchedBinary {
  path: string;
  sha256: string;
  /** Human description of where this came from, for the run's own record. */
  origin: string;
  commit?: string | undefined;
}

export async function fetchViewerBinary(
  source: GithubSource,
  log: (level: 'info' | 'warn', message: string) => void = () => undefined,
): Promise<FetchedBinary> {
  const repo = source.repo ?? DEFAULT_REPO;
  const artifact = source.artifact ?? DEFAULT_ARTIFACT;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swarm-fleet-gh-'));
  const haveGh = await ghAvailable();

  let origin: string;
  let commit: string | undefined;
  if (!haveGh) {
    // A specific run or commit means a workflow artifact, and that needs a token.
    if (source.runId !== undefined || source.commit !== undefined) {
      throw new Error(
        'pinning a build to a run or a commit reads a workflow artifact, which GitHub will ' +
          'not serve anonymously. Install `gh` and `gh auth login`, or use ' +
          '--github-tag nightly, which is a release asset and needs no token.',
      );
    }
    const release = await releaseFor(repo, source.tag);
    commit = release.commitish;
    await downloadAssets(release.assets, artifact, dir);
    origin = `${repo} release ${release.tag} (${release.commitish.slice(0, 12)}, no gh)`;
    log('info', `no gh on PATH, so took the ${release.tag} release instead of a run artifact`);
  } else if (source.tag !== undefined) {
    const tag = source.tag === 'latest' ? [] : [source.tag];
    await gh([
      'release',
      'download',
      ...tag,
      '--repo',
      repo,
      '--pattern',
      `${artifact}*`,
      '--dir',
      dir,
      '--clobber',
    ]);
    origin = `${repo} release ${source.tag}`;
  } else {
    const run = await resolveRun(repo, source);
    commit = run.headSha;
    await gh(['run', 'download', run.databaseId, '--repo', repo, '--name', artifact, '--dir', dir]);
    origin = `${repo} run ${run.databaseId} (${run.headSha.slice(0, 12)}, ${run.createdAt})`;
  }

  const binary = await findBinary(dir, artifact);
  await chmod(binary, 0o755);
  const sha256 = await sha256File(binary);
  await verifySidecar(dir, sha256, log);
  log('info', `fetched ${path.basename(binary)} from ${origin} (${sha256.slice(0, 12)}…)`);

  return { path: binary, sha256, origin, ...(commit === undefined ? {} : { commit }) };
}

/** Where a participant's machine keeps viewer binaries between runs. */
export function defaultCacheRoot(): string {
  const base =
    process.platform === 'win32'
      ? (process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'))
      : (process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'));
  return path.join(base, 'swarm-loadtest', 'viewer');
}

export interface PlatformBinaryRequest {
  platform: ViewerPlatform;
  repo?: string | undefined;
  /** A release tag; the newest release when absent. */
  tag?: string | undefined;
  cacheRoot?: string | undefined;
}

/**
 * The viewer for one platform, downloaded once and then reused.
 *
 * This is the participant path, and it is deliberately not
 * `fetchViewerBinary`. That one exists to put *one* trustworthy build on rented
 * machines and will reach for `gh` to pin a commit; this one runs on a
 * an ordinary desktop machine, where there is no `gh`, nobody is logged in, and the
 * machine may well be on a hotel network. So: release assets only, no token, and
 * a cache keyed by the release's own commit, so starting the tool a second time
 * costs one small API call rather than 8 MB.
 *
 * The cache key is the commit rather than the tag because `nightly` is a
 * rolling tag: keying on the tag alone would pin every participant to whatever
 * they downloaded first, which is exactly the "everyone ran a different build"
 * failure the release exists to prevent.
 */
export async function fetchViewerBinaryForPlatform(
  request: PlatformBinaryRequest,
  log: (level: 'info' | 'warn', message: string) => void = () => undefined,
): Promise<FetchedBinary> {
  const repo = request.repo ?? DEFAULT_REPO;
  const artifact = artifactFor(request.platform);
  const asset = assetFor(request.platform);
  const release = await releaseFor(repo, request.tag);
  const root = request.cacheRoot ?? defaultCacheRoot();
  const dir = path.join(root, repo.replace(/[^\w.-]+/g, '-'), `${release.tag}-${release.commitish.slice(0, 12)}`);
  const destination = path.join(dir, asset);
  const origin = `${repo} release ${release.tag} (${release.commitish.slice(0, 12)})`;

  const cached = await stat(destination).catch(() => undefined);
  if (cached?.isFile() === true && cached.size > 0) {
    const sha256 = await sha256File(destination);
    log('info', `using the cached ${asset} from ${origin}`);
    return { path: destination, sha256, origin: `${origin}, cached`, commit: release.commitish };
  }

  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(path.join(dir, '.download-'));
  try {
    try {
      await downloadAssets(release.assets, artifact, staging);
    } catch (error) {
      // The likeliest cause on a participant's machine is not a broken
      // download but a release that does not carry this platform yet, and the
      // person reading it can do nothing about that except ask for one.
      throw new Error(
        `there is no ${request.platform} viewer in ${repo} release ${release.tag}. ` +
          'A build for this platform is needed before it can take part. ' +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const binary = await findBinary(staging, artifact);
    const sha256 = await sha256File(binary);
    await verifySidecar(staging, sha256, log);
    await chmod(binary, 0o755);
    // Renamed into place only once it has been verified, so an interrupted
    // download can never be picked up as a cache hit next time.
    await rename(binary, destination).catch(async (error: unknown) => {
      // Another copy of the tool may have won the race and written the same
      // bytes; that is a cache hit, not a failure.
      const landed = await stat(destination).catch(() => undefined);
      if (landed?.isFile() !== true) {
        throw error;
      }
    });
    log('info', `fetched ${asset} from ${origin} (${sha256.slice(0, 12)}\u2026)`);
    return { path: destination, sha256, origin, commit: release.commitish };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

interface WorkflowRun {
  databaseId: string;
  headSha: string;
  createdAt: string;
}

/**
 * Which build to take.
 *
 * A specific run id is used as given. A commit resolves to that commit's
 * successful run, so a fleet can be pinned to the code being investigated. With
 * neither, it is the most recent successful build — the default a load rig
 * wants, since anything older is measuring a viewer nobody is working on.
 */
async function resolveRun(repo: string, source: GithubSource): Promise<WorkflowRun> {
  if (source.runId !== undefined) {
    const runs = await listRuns(repo, ['--limit', '50']);
    const found = runs.find((run) => run.databaseId === source.runId);
    return found ?? { databaseId: source.runId, headSha: 'unknown', createdAt: 'unknown' };
  }
  const filters =
    source.commit === undefined
      ? ['--workflow', source.workflow ?? DEFAULT_WORKFLOW, '--limit', '1']
      : ['--commit', source.commit, '--limit', '1'];
  const runs = await listRuns(repo, ['--status', 'success', ...filters]);
  const run = runs[0];
  if (run === undefined) {
    throw new Error(
      source.commit === undefined
        ? `no successful ${source.workflow ?? DEFAULT_WORKFLOW} run in ${repo}: has CI built this commit yet?`
        : `no successful build for ${source.commit} in ${repo}`,
    );
  }
  return run;
}

async function listRuns(repo: string, filters: readonly string[]): Promise<WorkflowRun[]> {
  const stdout = await gh([
    'run',
    'list',
    '--repo',
    repo,
    ...filters,
    '--json',
    'databaseId,headSha,createdAt',
  ]);
  const parsed = JSON.parse(stdout) as { databaseId: number; headSha: string; createdAt: string }[];
  return parsed.map((run) => ({
    databaseId: String(run.databaseId),
    headSha: run.headSha,
    createdAt: run.createdAt,
  }));
}

/**
 * The binary inside what `gh` unpacked.
 *
 * An artifact is a zip, so its layout is whatever the workflow put in it. The
 * binary's own name wins; a single-file artifact is unambiguous; anything else
 * is reported with what was actually found rather than guessed at.
 */
async function findBinary(dir: string, artifact: string): Promise<string> {
  const files = await filesUnder(dir);
  const named = files.find((file) => {
    const base = path.basename(file);
    // Windows will not execute a file without the suffix, so CI publishes the
    // asset with it while the artifact is still named without one.
    return (
      base === BINARY_NAME ||
      base === `${BINARY_NAME}.exe` ||
      base === artifact ||
      base === `${artifact}.exe`
    );
  });
  if (named !== undefined) {
    return named;
  }
  const candidates = files.filter((file) => !file.endsWith('.sha256') && !file.endsWith('.txt'));
  if (candidates.length === 1) {
    return candidates[0] as string;
  }
  throw new Error(
    `could not tell which downloaded file is the viewer. Found: ${
      files.map((file) => path.relative(dir, file)).join(', ') || '(nothing)'
    }`,
  );
}

/** CI publishes a `.sha256` beside the binary; if it came too, it must agree. */
async function verifySidecar(
  dir: string,
  sha256: string,
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<void> {
  const sidecar = (await filesUnder(dir)).find((file) => file.endsWith('.sha256'));
  if (sidecar === undefined) {
    return;
  }
  const expected = (await readFile(sidecar, 'utf8')).trim().split(/\s+/)[0];
  if (expected === undefined || expected.length !== 64) {
    log('warn', `${path.basename(sidecar)} is not a sha256 sum; ignoring it`);
    return;
  }
  if (expected !== sha256) {
    throw new Error(
      `the downloaded binary hashes ${sha256} but ${path.basename(sidecar)} says ${expected}`,
    );
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      out.push(...(await filesUnder(full)));
      continue;
    }
    const info = await stat(full).catch(() => undefined);
    if (info?.isFile() === true) {
      out.push(full);
    }
  }
  return out;
}

async function ghAvailable(): Promise<boolean> {
  try {
    await gh(['--version']);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- releases, without gh

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface Release {
  tag: string;
  commitish: string;
  assets: ReleaseAsset[];
}

/**
 * A release by tag, or the newest one.
 *
 * `/releases/latest` deliberately skips prereleases, and the rolling `nightly`
 * this rig deploys *is* a prerelease — so "newest" has to come from the list
 * rather than from `latest`, or a repository whose only builds are nightlies
 * would look like a repository with no builds.
 */
async function releaseFor(repo: string, tag: string | undefined): Promise<Release> {
  if (tag !== undefined && tag !== 'latest') {
    return toRelease(await api(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, repo));
  }
  const list = (await api(`https://api.github.com/repos/${repo}/releases?per_page=10`, repo)) as
    | unknown[]
    | undefined;
  const newest = Array.isArray(list) ? list[0] : undefined;
  if (newest === undefined) {
    throw new Error(
      `${repo} has published no releases, so there is nothing to download without a token. ` +
        'Install `gh` to read workflow artifacts instead.',
    );
  }
  return toRelease(newest);
}

function toRelease(payload: unknown): Release {
  const record = payload as {
    tag_name?: string;
    target_commitish?: string;
    assets?: ReleaseAsset[];
  };
  return {
    tag: record.tag_name ?? 'unknown',
    commitish: record.target_commitish ?? 'unknown',
    assets: record.assets ?? [],
  };
}

async function api(url: string, repo: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'swarm-fleet' },
  });
  if (response.status === 404) {
    throw new Error(
      `${repo} has no such release, or the repository is private. A private repository needs ` +
        '`gh` and a login; a public one needs neither.',
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${url}`);
  }
  return response.json();
}

/** The binary and whatever sidecars came with it, by the same pattern gh uses. */
async function downloadAssets(
  assets: readonly ReleaseAsset[],
  artifact: string,
  dir: string,
): Promise<void> {
  const wanted = assets.filter((asset) => asset.name.startsWith(artifact));
  if (wanted.length === 0) {
    throw new Error(
      `no release asset starts with \`${artifact}\`. Found: ${
        assets.map((asset) => asset.name).join(', ') || '(none)'
      }`,
    );
  }
  for (const asset of wanted) {
    const response = await fetch(asset.browser_download_url, {
      headers: { 'user-agent': 'swarm-fleet' },
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`downloading ${asset.name} failed: ${response.status}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength !== asset.size) {
      throw new Error(
        `${asset.name} arrived as ${body.byteLength} bytes, and the release says ${asset.size}`,
      );
    }
    await writeFile(path.join(dir, asset.name), body);
  }
}

function gh(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', [...args], { maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`gh ${args.join(' ')} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}
