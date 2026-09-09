#!/usr/bin/env node
/**
 * swarm-fleet: run many viewers, collect what they report.
 *
 *   swarm-fleet run     [--mode cohort|ramp|soak|flood|port-ceiling] ...
 *   swarm-fleet agent   --stdio          (started by the controller over ssh)
 *   swarm-fleet mock    watch <owner> <topic> ...   (the fake viewer)
 *   swarm-fleet report  <run-dir>
 *   swarm-fleet doctor  [--viewers n]    (preflight this machine only)
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Args, defined } from './args.js';
import { Controller, type RunResult } from './controller.js';
import { machineInfo, preflight } from './agent/preflight.js';
import { FleetAgent } from './agent/agent.js';
import { renderReport } from './report/markdown.js';
import type { ConsoleView } from './report/console.js';
import { buildSummary, type RunSummary } from './report/summary.js';
import { createRunDir, runId, writeJson } from './run-dir.js';
import { AgentTarget, resolveScenario, Scenario } from './scenario.js';
import {
  DEFAULT_DEPLOY_ROOT,
  deployFleet,
  discardArchive,
  type HostOutcome,
  planDeployment,
} from './deploy/deploy.js';
import { fetchViewerBinary } from './deploy/github.js';
import { PublisherConfig, segmentsBeforeViewersCanJoin } from './publisher/config.js';
import type { PublisherHandle, PublisherStats } from './publisher/control.js';
import { ndjsonChannel } from './transport/ndjson.js';
import { ToAgent, type FromAgent } from './transport/protocol.js';
import { runMockViewer } from './mock/viewer.js';

const USAGE = `usage: swarm-fleet <command> [options]

commands:
  run       launch a fleet of viewers and report what happened
  agent     serve one machine's viewers over stdio (the controller starts this)
  mock      the built-in fake viewer, for developing the runner itself
  report    re-render report.md from a run directory's summary.json
  doctor    preflight this machine without running anything
  deploy    push the viewer and the agent to the machines, without running
  publish   put a live HLS stream on Swarm, for viewers to watch

run options:
  --scenario <file>      JSON scenario; flags below override it
  --mode <mode>          cohort | ramp | soak | flood | port-ceiling  (default cohort)
  --viewers <n>          viewers for cohort / soak / flood
  --duration <s>         seconds each viewer watches
  --segments <n>         segments each viewer watches instead of a duration
  --stream <owner:topic>  repeatable; several streams separate popularity from capacity
  --owner <hex> --topic <uuid>   a single stream, the same as one --stream
  --assignment <mode>    all | round-robin  (default all)
  --binary <path>        weeb-3-rs-hls, or "mock" for the fake viewer
  --network <net>        mainnet | testnet  (default mainnet)
  --vod                  read one playlist snapshot instead of following live
  --peers <n>            CONNECTION_BUILDUP_LIMIT per viewer  (default 200)
  --dial-rate <n>        connections/s a viewer may open, 0 = unpaced burst
  --agent <host>         repeatable; "local" runs in-process (default local)
  --ramp-start / --ramp-step / --ramp-interval / --ramp-max
  --stop-degraded <f>    degraded-viewer share that ends a ramp  (default 0.10)
  --stop-join <f>        join success below which a ramp ends    (default 0.95)
  --hold <s>             how long a breach must hold             (default 30)
  --min-start-interval <ms>   floor between viewer starts        (default 250)
  --grace <ms>           time a viewer gets to finish after SIGTERM (default 15000)
  --max-run <s>          hard ceiling on the whole run
  --sample-interval <ms> resource sampling period               (default 1000)
  --count-sockets        sample machine-wide TCP counts (port-ceiling does this anyway)
  --env <KEY=VALUE>      repeatable; passed to every viewer process
                         (e.g. --env WEEB_3_CHUNK_CACHE=32)
  --label <name>         names the run directory
  --runs-dir <dir>       where run directories go                (default runs)
  --publish              publish a live stream for this run and watch it
  --publish-source <s>   testsrc, or a media file           (default testsrc)
  --publish-duration <s> stream length; omit to run until the fleet stops
  --publish-segment-duration <s> / --publish-window <n>
  --publish-size <WxH> / --publish-bitrate <rate> / --publish-gateway <url>
  --publish-topic <s>    stream topic                       (default a fresh UUID)
  --publish-registry     also write a catalog entry
  --deploy               push the viewer and the agent to every --agent host first
  --from-github          take the viewer from CI instead of --binary (implies --deploy)
  --github-repo <o/n> --github-tag <tag> --github-commit <sha> --github-run <id>
  --deploy-root <dir>    where deployed artefacts live      (default /tmp/swarm-fleet)
  --acknowledge-flood    required by --mode flood
  --force                run even if preflight refuses, and mark the run invalid
  --json                 print summary.json to stdout instead of a human report
  --quiet                no live view

publish options:
  --source <testsrc|path>  synthetic pattern, or a media file   (default testsrc)
  --duration <s>           stream length, 0 = until Ctrl-C      (default 60)
  --segment-duration <s>   target segment length                (default 2)
  --window <n>             segments kept in the live manifest   (default 10)
  --size <WxH> --bitrate <rate> --gateway <url> --topic <string>
  --registry               also write a catalog entry
  --dump <dir>             save every published manifest here

deploy options:
  --agent <host>         repeatable; the machines to deploy to
  --binary <path>        the viewer to ship
  --from-github          take the viewer from CI instead of --binary
  --github-repo <o/n> --github-tag <tag> --github-commit <sha> --github-run <id>
  --deploy-root <dir>    where deployed artefacts live      (default /tmp/swarm-fleet)
  --json                 print the deployment report as JSON
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = new Args(argv.slice(1));

  switch (command) {
    case 'run':
      return runFleet(args);
    case 'agent':
      return serveAgent();
    case 'mock':
      return runMock(argv.slice(1));
    case 'report':
      return rerender(args);
    case 'doctor':
      return doctor(args);
    case 'deploy':
      return deployCommand(args);
    case 'publish':
      return publishCommand(args);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

// ------------------------------------------------------------------- run

async function runFleet(args: Args): Promise<number> {
  const parsed = Scenario.parse(await scenarioFromArgs(args));
  const deployed = await deployForRun(args, parsed);
  const published = await startPublisherForRun(deployed.scenario);
  const scenario = resolveScenario(published.scenario);
  const id = runId(scenario.label);
  const dir = await createRunDir(scenario.runsDir, id);
  if (deployed.report !== undefined) {
    // Written before the run rather than with the summary: if the run dies at
    // preflight, what was deployed is the first thing worth knowing.
    await writeJson(path.join(dir, 'deploy.json'), deployed.report);
  }

  // Loaded here rather than imported: the live view is the controller's, and
  // the deployed agent runs the same `cli.js` without cli-table3 beside it.
  const { ConsoleView } = await import('./report/console.js');
  const view: ConsoleView = new ConsoleView({ durationS: scenario.durationS });
  const quiet = args.has('quiet');
  const controller = new Controller(scenario, id, dir, {
    ...(quiet ? {} : { onSnapshot: (snapshot) => view.render(snapshot) }),
    // Through the view, so a log does not land inside the block it redraws.
    onLog: (level, message) => view.log(`${level}: ${message}`),
  });

  process.stderr.write(
    `run ${id}\n` +
      `  mode ${scenario.mode}, peak ${scenario.peakViewers} viewers, ` +
      `${scenario.spec.streams.length} stream(s), binary ${scenario.spec.binary}\n` +
      `  ${dir}\n\n`,
  );

  let aborting = false;
  const onSignal = (signal: string): void => {
    if (aborting) {
      process.exit(130);
    }
    aborting = true;
    view.log(`\n${signal}: stopping viewers and writing the report`);
    void controller.abort(signal);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let result: RunResult;
  try {
    result = await controller.run(args.has('force'));
  } catch (error) {
    view.release();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    // Hand the terminal back before anything else prints: the block below the
    // cursor is finished with, and what follows belongs in the scrollback.
    view.release();
    // The publisher outlives a failed run only long enough to be told to stop:
    // an ffmpeg left encoding into Swarm is both a cost and a contaminated
    // measurement for whatever runs next.
    const stats = await stopPublisher(published.handle);
    if (stats !== undefined) {
      await writeJson(path.join(dir, 'publisher.json'), stats);
      process.stderr.write(
        `publisher: ${stats.segments} segments, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB, ` +
          `${stats.mediaSeconds.toFixed(0)}s of media, ` +
          `${stats.finalized ? 'finalized as VOD' : 'not finalized'}\n` +
          `           re-watch it with: --stream ${stats.owner}:${stats.topic}\n`,
      );
    }
  }

  const summary = buildSummary(result);
  await writeJson(path.join(dir, 'summary.json'), summary);
  const report = renderReport(summary);
  await writeFile(path.join(dir, 'report.md'), report, 'utf8');

  if (args.has('json')) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${report}`);
    process.stderr.write(`\nwrote ${path.join(dir, 'report.md')}\n`);
  }
  // A distinct code, so a supervisor can tell "Swarm coped" from "the rig did
  // not, so believe nothing here".
  return result.valid ? 0 : 4;
}

async function scenarioFromArgs(args: Args): Promise<unknown> {
  const file = args.value('scenario');
  const base: Record<string, unknown> =
    file === undefined ? {} : (JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>);

  const streams = args.values('stream').map((entry) => {
    const [owner, topic] = entry.split(':');
    if (owner === undefined || topic === undefined || owner === '' || topic === '') {
      throw new Error(`--stream expects <owner>:<topic>, got ${entry}`);
    }
    return { owner, topic };
  });
  const owner = args.value('owner');
  const topic = args.value('topic');
  if (owner !== undefined && topic !== undefined) {
    streams.push({ owner, topic });
  }

  const agents = args.values('agent').map((host) => ({ host }));
  const ramp = defined({
    start: args.number('ramp-start'),
    step: args.number('ramp-step'),
    intervalS: args.number('ramp-interval'),
    max: args.number('ramp-max'),
  });
  const stop = defined({
    degradedFraction: args.number('stop-degraded'),
    joinSuccessRate: args.number('stop-join'),
    holdS: args.number('hold'),
  });
  const admission = defined({ minStartIntervalMs: args.number('min-start-interval') });
  const env: Record<string, string> = {};
  for (const entry of args.values('env')) {
    const at = entry.indexOf('=');
    if (at <= 0) {
      throw new Error(`--env expects KEY=VALUE, got ${entry}`);
    }
    env[entry.slice(0, at)] = entry.slice(at + 1);
  }

  const overrides: Partial<Scenario> = defined({
    mode: (args.value('mode') ?? base['mode'] ?? 'cohort') as Scenario['mode'],
    label: args.value('label'),
    viewers: args.number('viewers'),
    durationS: args.number('duration'),
    segments: args.number('segments'),
    network: args.value('network') as Scenario['network'] | undefined,
    assignment: args.value('assignment') as Scenario['assignment'] | undefined,
    binary: args.value('binary'),
    peerLimit: args.number('peers'),
    dialRate: args.number('dial-rate'),
    sampleIntervalMs: args.number('sample-interval'),
    graceMs: args.number('grace'),
    maxRunS: args.number('max-run'),
    runsDir: args.value('runs-dir'),
    live: args.has('vod') ? false : undefined,
    countSockets: args.has('count-sockets') ? true : undefined,
    acknowledgeFlood: args.has('acknowledge-flood') ? true : undefined,
    ...(streams.length > 0 ? { streams } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(Object.keys(ramp).length > 0 ? { ramp } : {}),
    ...(Object.keys(stop).length > 0 ? { stop } : {}),
    ...(Object.keys(admission).length > 0 ? { admission } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }) as Partial<Scenario>;

  const merged = { ...base, ...overrides };
  const publisher = publisherFromArgs(args, base['publisher'] as Scenario['publisher']);
  if (publisher !== undefined) {
    merged['publisher'] = publisher;
  }
  // A publishing run supplies its own stream once ffmpeg is up, so the only
  // scenario with nothing to watch is one with neither.
  if (
    publisher === undefined &&
    (!Array.isArray(merged['streams']) || (merged['streams'] as unknown[]).length === 0)
  ) {
    throw new Error(
      'no stream to watch: pass --stream <owner>:<topic>, or --owner and --topic, or ' +
        '--publish to make one, or a --scenario file',
    );
  }
  return merged;
}

// ----------------------------------------------------------------- agent

async function serveAgent(): Promise<number> {
  const channel = ndjsonChannel<FromAgent, ToAgent>({
    input: process.stdin,
    output: process.stdout,
    schema: ToAgent,
    onMalformed: (_line, reason) => process.stderr.write(`agent: bad control line: ${reason}\n`),
  });
  const agent = new FleetAgent(channel);
  await agent.start();

  return new Promise<number>((resolve) => {
    // The controller closing the pipe is the shutdown signal, and the agent
    // must not outlive it holding viewers open.
    channel.onClose(() => resolve(0));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        channel.close();
        resolve(0);
      });
    }
  });
}

// ------------------------------------------------------------------ mock

async function runMock(argv: readonly string[]): Promise<number> {
  let terminate: (() => void) | undefined;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => terminate?.());
  }
  await runMockViewer(argv, {
    event: (line) => process.stdout.write(`${line}\n`),
    human: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
    onTerminate: (handler) => {
      terminate = handler;
    },
  });
  return 0;
}



// -------------------------------------------------------------- publisher

/**
 * A publisher for this run, if the scenario asked for one.
 *
 * `control.ts` is imported dynamically for a reason that is not style: it pulls
 * in an 11 MB Swarm SDK, and the same `cli.js` runs as the agent on every
 * machine in the fleet. An agent that never publishes should not pay to carry a
 * publisher, and the deployed agent bundle does not even contain it.
 *
 * The stream is prepended to `streams`, so `--publish` is what the viewers
 * watch even when a `--stream` was also given.
 */
async function startPublisherForRun(
  scenario: Scenario,
): Promise<{ scenario: Scenario; handle: PublisherHandle | undefined }> {
  const requested = scenario.publisher;
  if (requested === undefined) {
    return { scenario, handle: undefined };
  }
  const config = PublisherConfig.parse(requested);
  if (scenario.agents.some((agent) => agent.host === 'local')) {
    process.stderr.write(
      'publisher: this machine will both encode video and host viewers. Encoding costs ' +
        'several cores, so preflight will probably refuse the run, and the numbers would ' +
        'describe ffmpeg as much as Swarm. Put viewers on another box with --agent <host>, ' +
        'or pass --force and read the caveat in the report.\n',
    );
  }

  const { startPublisher } = await import('./publisher/control.js');
  const handle = await startPublisher(config, (level, message) =>
    process.stderr.write(`publisher: ${level === 'warn' ? 'warn: ' : ''}${message}\n`),
  );

  // Viewers cannot join a live edge that has no runway behind it, so the run
  // waits here rather than starting viewers that would all report a join
  // latency describing the publisher.
  const needed = segmentsBeforeViewersCanJoin(config);
  const timeoutMs = Math.max(60_000, needed * config.segmentDuration * 2_000 + 30_000);
  try {
    await handle.joinable(timeoutMs);
  } catch (error) {
    await handle.stop();
    throw error;
  }

  return {
    scenario: { ...scenario, streams: [handle.stream, ...scenario.streams] },
    handle,
  };
}

async function stopPublisher(
  handle: PublisherHandle | undefined,
): Promise<PublisherStats | undefined> {
  if (handle === undefined) {
    return undefined;
  }
  try {
    return await handle.stop();
  } catch (error) {
    process.stderr.write(
      `publisher: stopping it failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

function publisherFromArgs(
  args: Args,
  base: Scenario['publisher'],
): Scenario['publisher'] | undefined {
  const overrides = defined({
    source: args.value('publish-source'),
    durationS: args.number('publish-duration'),
    segmentDuration: args.number('publish-segment-duration'),
    windowSize: args.number('publish-window'),
    size: args.value('publish-size'),
    bitrate: args.value('publish-bitrate'),
    gateway: args.value('publish-gateway'),
    topic: args.value('publish-topic'),
    dumpDir: args.value('publish-dump'),
    registry: args.has('publish-registry') ? true : undefined,
  });
  if (!args.has('publish') && base === undefined && Object.keys(overrides).length === 0) {
    return undefined;
  }
  return { ...base, ...overrides };
}

/**
 * `publish` on its own: the stream, without a fleet.
 *
 * Still worth having as a command. Watching one stream by hand is how a viewer
 * change gets checked, and a stream that outlives the run that made it is how
 * several fleet runs get compared against identical content.
 */
async function publishCommand(args: Args): Promise<number> {
  // A standalone publish is bounded by default: someone at a terminal wants a
  // stream to test against, not a process they have to remember to kill.
  // `--duration 0` is the way to ask for one that runs until Ctrl-C, which is
  // what `run --publish` uses, since there the run decides when to stop it.
  const duration = args.number('duration') ?? 60;
  const config = PublisherConfig.parse(
    defined({
      source: args.value('source'),
      durationS: duration > 0 ? duration : undefined,
      segmentDuration: args.number('segment-duration'),
      windowSize: args.number('window'),
      size: args.value('size'),
      bitrate: args.value('bitrate'),
      gateway: args.value('gateway'),
      topic: args.value('topic'),
      dumpDir: args.value('dump'),
      registry: args.has('registry') ? true : undefined,
    }),
  );

  const { startPublisher } = await import('./publisher/control.js');
  const handle = await startPublisher(config, (level, message) =>
    process.stderr.write(`${level === 'warn' ? 'warn: ' : ''}${message}\n`),
  );
  process.stderr.write(
    `\nwatch it with:\n` +
      `  weeb-3-rs-hls watch ${handle.stream.owner} ${handle.stream.topic} --live\n` +
      `  swarm-fleet run --stream ${handle.stream.owner}:${handle.stream.topic}\n\n`,
  );

  let stopping = false;
  const finish = (): void => {
    if (stopping) {
      process.exit(130);
    }
    stopping = true;
    process.stderr.write('\nfinalizing the stream as VOD (Ctrl-C again to abort)\n');
    void handle.stop();
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);

  // A bounded stream ends on its own; an unbounded one ends when a signal tells
  // it to. Either way this is the one place the outcome is printed.
  const stats = await handle.finished();
  process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  return 0;
}

// ---------------------------------------------------------------- deploy

export interface DeployReport {
  root: string;
  binary: {
    source: string;
    sha256: string;
    remotePath: string;
    origin?: string | undefined;
    commit?: string | undefined;
  };
  agent: { sha256: string; remoteDir: string; command: string };
  hosts: HostOutcome[];
}

/**
 * Deploy before a run, when asked.
 *
 * The rewrite is the point: every agent is pointed at the same
 * content-addressed binary path and at the agent runtime that was just
 * unpacked, so `run.json` records the paths the run actually used and
 * preflight's insistence that every agent report one sha256 becomes a check
 * that the deploy worked rather than a check that a human copied files
 * consistently.
 */
async function deployForRun(
  args: Args,
  scenario: Scenario,
): Promise<{ scenario: Scenario; report: DeployReport | undefined }> {
  const fromGithub = args.has('from-github');
  if (!args.has('deploy') && !fromGithub) {
    return { scenario, report: undefined };
  }
  const log = (level: 'info' | 'warn', message: string): void => {
    process.stderr.write(`deploy: ${level === 'warn' ? 'warn: ' : ''}${message}\n`);
  };

  const source = fromGithub
    ? await fetchViewerBinary(
        defined({
          repo: args.value('github-repo'),
          artifact: args.value('github-artifact'),
          workflow: args.value('github-workflow'),
          tag: args.value('github-tag'),
          commit: args.value('github-commit'),
          runId: args.value('github-run'),
        }),
        log,
      )
    : undefined;

  const report = await runDeployment({
    binary: source?.path ?? scenario.binary,
    root: args.value('deploy-root'),
    agents: scenario.agents,
    ...(source === undefined ? {} : { origin: source.origin, commit: source.commit }),
    log,
  });

  return {
    scenario: {
      ...scenario,
      binary: report.binary.remotePath,
      agents: scenario.agents.map((agent) =>
        agent.host === 'local' ? agent : { ...agent, command: report.agent.command },
      ),
    },
    report,
  };
}

async function runDeployment(options: {
  binary: string;
  root: string | undefined;
  agents: readonly AgentTarget[];
  origin?: string | undefined;
  commit?: string | undefined;
  log: (level: 'info' | 'warn', message: string) => void;
}): Promise<DeployReport> {
  const plan = await planDeployment({
    binary: options.binary,
    root: options.root,
    log: options.log,
  });
  try {
    const hosts = await deployFleet(options.agents, plan, options.log);
    return {
      root: plan.root,
      binary: {
        source: plan.binarySource,
        sha256: plan.binarySha256,
        remotePath: plan.binaryRemotePath,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.commit === undefined ? {} : { commit: options.commit }),
      },
      agent: {
        sha256: plan.agentSha256,
        remoteDir: plan.agentRemoteDir,
        command: plan.agentCommand,
      },
      hosts,
    };
  } finally {
    // The tarball is a build product of this invocation; nothing reads it again.
    await discardArchive(plan);
  }
}

/**
 * `deploy` on its own: get the machines ready, run nothing.
 *
 * Worth having separately because it is the step that fails for boring reasons
 * — a host with no `node`, an ssh key that was never copied, an arm64 binary
 * aimed at x86 boxes — and finding that out during a 200-viewer launch wastes
 * the launch.
 */
async function deployCommand(args: Args): Promise<number> {
  const agents: AgentTarget[] = args
    .values('agent')
    .map((host) => AgentTarget.parse({ host }));
  if (agents.length === 0) {
    process.stderr.write(
      'usage: swarm-fleet deploy --agent <host> [--agent <host>] ' +
        '[--binary <path> | --from-github]\n',
    );
    return 2;
  }

  const log = (level: 'info' | 'warn', message: string): void => {
    process.stderr.write(`deploy: ${level === 'warn' ? 'warn: ' : ''}${message}\n`);
  };
  const source = args.has('from-github')
    ? await fetchViewerBinary(
        defined({
          repo: args.value('github-repo'),
          artifact: args.value('github-artifact'),
          workflow: args.value('github-workflow'),
          tag: args.value('github-tag'),
          commit: args.value('github-commit'),
          runId: args.value('github-run'),
        }),
        log,
      )
    : undefined;

  const report = await runDeployment({
    binary: source?.path ?? args.value('binary') ?? '../weeb-3-rs-hls/target/release/weeb-3-rs-hls',
    root: args.value('deploy-root'),
    agents,
    ...(source === undefined ? {} : { origin: source.origin, commit: source.commit }),
    log,
  });

  if (args.has('json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `viewer  ${report.binary.remotePath}\n` +
      `        sha256 ${report.binary.sha256}\n` +
      (report.binary.origin === undefined ? '' : `        from ${report.binary.origin}\n`) +
      `agent   ${report.agent.command}\n\n`,
  );
  for (const host of report.hosts) {
    process.stdout.write(
      `${host.name.padEnd(20)} ${host.facts.unameS}/${host.facts.unameM} ` +
        `node ${host.facts.nodeVersion ?? '?'}  viewer ${host.binary}, agent ${host.agent}` +
        `${host.uploadedBytes > 0 ? ` (${(host.uploadedBytes / 1024 / 1024).toFixed(1)} MB in ${host.ms} ms)` : ''}\n`,
    );
  }
  process.stdout.write(
    `\nrun against these with: --agent <host> --binary ${report.binary.remotePath}\n` +
      '(or just pass --deploy to `run`, which does all of this and wires it up)\n',
  );
  return 0;
}

// ---------------------------------------------------------------- report

async function rerender(args: Args): Promise<number> {
  const dir = args.positional[0];
  if (dir === undefined) {
    process.stderr.write('usage: swarm-fleet report <run-dir>\n');
    return 2;
  }
  const summary = JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')) as RunSummary;
  const report = renderReport(summary);
  await writeFile(path.join(dir, 'report.md'), report, 'utf8');
  process.stdout.write(report);
  return summary.verdict.valid ? 0 : 4;
}

// ---------------------------------------------------------------- doctor

async function doctor(args: Args): Promise<number> {
  const machine = await machineInfo();
  const viewers = args.number('viewers') ?? 100;
  const peers = args.number('peers') ?? 200;
  const report = await preflight({
    machine,
    maxViewers: viewers,
    peerLimit: peers,
    binary: args.value('binary') ?? 'mock',
  });

  process.stdout.write(
    `${machine.hostname}: ${machine.cores} cores, ${(machine.totalMemBytes / 1024 ** 3).toFixed(1)} GiB, ` +
      `${machine.platform}/${machine.arch}\n` +
      `sizing for ${viewers} viewers at ${peers} peers\n\n`,
  );
  for (const check of report.checks) {
    const mark = check.ok ? 'ok  ' : check.fatal ? 'FAIL' : 'warn';
    process.stdout.write(`${mark}  ${check.name.padEnd(18)}${check.detail}\n`);
  }
  process.stdout.write(`\n${report.ok ? 'this machine can host the run' : 'preflight would refuse this run'}\n`);
  return report.ok ? 0 : 4;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
