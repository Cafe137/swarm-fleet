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
import { fileURLToPath } from 'node:url';
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
import { VultrClient } from './provision/vultr.js';
import { capacityOf, choosePlan, demandFor, estimateCost, isDedicated, spreadRegions } from './provision/sizing.js';
import { ensureSshKey } from './provision/ssh-key.js';
import { agentsFromArgs } from './provision/agents.js';
import {
  DEFAULT_SSH_USER,
  DEFAULT_STATE_DIR,
  FLEET_TAG,
  destroyFleet,
  listFleetStates,
  provisionFleet,
} from './provision/provision.js';

const USAGE = `usage: swarm-fleet <command> [options]

commands:
  run       launch a fleet of viewers and report what happened
  agent     serve one machine's viewers over stdio (the controller starts this)
  mock      the built-in fake viewer, for developing the runner itself
  report    re-render report.md from a run directory's summary.json
  doctor    preflight this machine without running anything
  deploy    push the viewer and the agent to the machines, without running
  publish   put a live HLS stream on Swarm, for viewers to watch
  provision rent machines to run viewers on
  destroy   give them back

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
  --fleet <id>           machines from provision, with their ssh settings
  --ramp-start / --ramp-step / --ramp-interval / --ramp-max
  --stop-degraded <f>    degraded-viewer share that ends a ramp  (default 0.10)
  --stop-join <f>        join success below which a ramp ends    (default 0.95)
  --stop-peers <f>       share of viewers holding their full peer footprint
                         below which a ramp ends: the connection ceiling
                         (default 0.90)
  --hold <s>             how long a breach must hold             (default 30)
  --min-start-interval <ms>   floor between viewer starts        (default 250)
  --grace <ms>           time a viewer gets to finish after SIGTERM (default 15000)
  --max-run <s>          hard ceiling on the whole run
  --straggler-grace <s>  seconds past its duration before a viewer is killed
                         as hung, rather than waited for            (default 30)
  --sample-interval <ms> resource sampling period               (default 1000)
  --count-sockets        sample machine-wide TCP counts (port-ceiling does this anyway)
  --env <KEY=VALUE>      repeatable; passed to every viewer process
                         (e.g. --env WEEB_3_CHUNK_CACHE=32)
  --label <name>         names the run directory
  --runs-dir <dir>       where run directories go                (default runs)
  --verify               check every chunk against its content address; 8.3%
                         more CPU per viewer, and what a real client pays
  --unsafe               skip that check                      (the default)
  --settle               peer every viewer to its full footprint and hold it
                         there; start the stream and release them together
  --settle-peers <n>     peers to hold before release        (default --peers)
  --settle-timeout <s>   release anyway after this long      (default 300)
  --no-settle            start viewers watching as they come up (the default)
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

provision options:
  --count <n>            machines to rent                      (default 1)
  --viewers-per-box <n>  what each must hold; sizes the plan   (default 50)
  --peers <n>            peers per viewer, for the port budget (default 128)
  --bitrate <Mbps>       stream bitrate per viewer, for the CPU budget (default 2)
  --plan <id>            skip sizing and use this plan exactly
  --shared               allow shared-vCPU plans; the default is dedicated only
  --region <id>          repeatable; round-robined  (default a spread of five)
  --os <id>              Vultr os_id                (default 2136, Debian 12)
  --ssh-key <path>       public key to install      (default ~/.ssh/id_*.pub)
  --ssh-user <name>      user to connect as         (default root)
  --state-dir <dir>      where fleet records go     (default provisioned)
  --ready-timeout <s>    give up waiting for cloud-init        (default 600)
  --plans                list plans that fit and exit, renting nothing
  --dry-run              print what would be rented, and what it would cost
  --json                 machine-readable output

destroy options:
  --fleet <id>           the fleet to destroy
  --all                  every instance this rig ever created
  --list                 show what exists and exit
  --state-dir <dir>      where fleet records live   (default provisioned)
  --json                 machine-readable output

deploy options:
  --agent <host>         repeatable; the machines to deploy to
  --binary <path>        the viewer to ship
  --from-github          take the viewer from CI instead of --binary
  --github-repo <o/n> --github-tag <tag> --github-commit <sha> --github-run <id>
  --deploy-root <dir>    where deployed artefacts live      (default /tmp/swarm-fleet)
  --json                 print the deployment report as JSON
`;

/**
 * Load `.env` from the fleet root, if there is one.
 *
 * `provision` needs `VULTR_API_KEY`, and a provider key does not belong in
 * shell history or in a scenario file that gets written into a run directory.
 * `.env` is gitignored and `.env.example` names the variable without the
 * secret.
 *
 * Everything is tolerated: no file, an unreadable one, or a Node without
 * `loadEnvFile` (added in 20.12). A real environment variable already set wins,
 * because that is how CI will pass one. This must never be the reason a run
 * fails to start — the commands that need a key say so themselves.
 */
function loadDotEnv(): void {
  const load = (process as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof load !== 'function') {
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Resolves to the package root from both `src/cli.ts` and `dist/cli.js`.
  for (const candidate of [path.join(here, '..', '.env'), path.resolve('.env')]) {
    try {
      load.call(process, candidate);
      return;
    } catch {
      // Next candidate.
    }
  }
}

async function main(): Promise<number> {
  loadDotEnv();
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
    case 'provision':
      return provisionCommand(args);
    case 'destroy':
      return destroyCommand(args);
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
    // A settled run publishes only once its audience is in place.
    onSettled: () => published.start(),
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
    const stats = await stopPublisher(published.handle());
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

  const agents = await agentsFromArgs(args);
  const ramp = defined({
    start: args.number('ramp-start'),
    step: args.number('ramp-step'),
    intervalS: args.number('ramp-interval'),
    max: args.number('ramp-max'),
  });
  const stop = defined({
    degradedFraction: args.number('stop-degraded'),
    joinSuccessRate: args.number('stop-join'),
    peerAttainment: args.number('stop-peers'),
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

  // `--settle` on its own is the whole feature; the two knobs are for a box
  // that needs longer than the default to peer a large cohort.
  const settle: Record<string, number> = {};
  const settlePeers = args.number('settle-peers');
  const settleTimeout = args.number('settle-timeout');
  if (settlePeers !== undefined) {
    settle['peerUp'] = settlePeers;
  }
  if (settleTimeout !== undefined) {
    settle['timeoutS'] = settleTimeout;
  }
  const settleRequested =
    args.has('settle') || settlePeers !== undefined || settleTimeout !== undefined;

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
    stragglerGraceS: args.number('straggler-grace'),
    runsDir: args.value('runs-dir'),
    live: args.has('vod') ? false : undefined,
    countSockets: args.has('count-sockets') ? true : undefined,
    verifyChunks: args.has('verify') ? true : args.has('unsafe') ? false : undefined,
    acknowledgeFlood: args.has('acknowledge-flood') ? true : undefined,
    ...(streams.length > 0 ? { streams } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(Object.keys(ramp).length > 0 ? { ramp } : {}),
    ...(args.has('no-settle')
      ? { settle: false }
      : settleRequested
        ? { settle: Object.keys(settle).length > 0 ? settle : true }
        : {}),
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
): Promise<{ scenario: Scenario; start: () => Promise<void>; handle: () => PublisherHandle | undefined }> {
  const requested = scenario.publisher;
  if (requested === undefined) {
    return { scenario, start: async () => undefined, handle: () => undefined };
  }
  const parsed = PublisherConfig.parse(requested);
  if (scenario.agents.some((agent) => agent.host === 'local')) {
    process.stderr.write(
      'publisher: this machine will both encode video and host viewers. Encoding costs ' +
        'several cores, so preflight will probably refuse the run, and the numbers would ' +
        'describe ffmpeg as much as Swarm. Put viewers on another box with --agent <host>, ' +
        'or pass --force and read the caveat in the report.\n',
    );
  }

  const control = await import('./publisher/control.js');
  const { stream, config } = control.planStream(parsed);
  const log = (level: 'info' | 'warn', message: string): void =>
    void process.stderr.write(`publisher: ${level === 'warn' ? 'warn: ' : ''}${message}\n`);

  let handle: PublisherHandle | undefined;
  const start = async (): Promise<void> => {
    if (handle !== undefined) {
      return;
    }
    handle = await control.startPublisher(config, log);
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
  };

  // A settled run starts the stream from the controller's `onSettled`, once
  // every viewer is peered and parked. Any other run starts it here, because
  // its viewers begin watching the moment they come up and a stream that does
  // not exist yet is a join failure rather than a wait.
  if (scenario.settle === undefined || scenario.settle === false) {
    await start();
  }

  return {
    scenario: { ...scenario, publisher: config, streams: [stream, ...scenario.streams] },
    start,
    handle: () => handle,
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

// ------------------------------------------------------------- provision

/**
 * Five regions on three continents, so the default fleet is not one
 * datacentre's view of Swarm.
 *
 * A fleet in one location shares an upstream and correlates its Kademlia
 * neighbourhoods, which measures something narrower than an audience. Spreading
 * costs nothing — the plans are priced per hour, not per region.
 */
const DEFAULT_REGIONS = ['fra', 'ams', 'lhr', 'ewr', 'sjc'];

function vultrClient(): VultrClient {
  return new VultrClient({ apiKey: process.env['VULTR_API_KEY'] });
}

function requireApiKey(): number | undefined {
  if ((process.env['VULTR_API_KEY'] ?? '') !== '') {
    return undefined;
  }
  process.stderr.write(
    'VULTR_API_KEY is not set.\n' +
      '  Create a key at https://my.vultr.com/settings/#settingsapi, then:\n' +
      '    export VULTR_API_KEY=...\n' +
      '  The key is also IP-restricted by default; allow this machine there too.\n',
  );
  return 2;
}

async function provisionCommand(args: Args): Promise<number> {
  const count = args.number('count') ?? 1;
  const viewersPerBox = args.number('viewers-per-box') ?? 50;
  const peers = args.number('peers') ?? 128;
  const bitrate = args.number('bitrate') ?? 2;
  const regions = args.values('region').length > 0 ? args.values('region') : DEFAULT_REGIONS;
  const stateDir = args.value('state-dir') ?? DEFAULT_STATE_DIR;
  const dedicatedOnly = !args.has('shared');
  const spread = spreadRegions(count, regions);
  const used = [...new Set(spread)];

  // Sizing runs against the public catalogue, so `--plans` and `--dry-run`
  // work before an account exists.
  const catalogue = new VultrClient();
  const plans = await catalogue.listPlans();
  const filter = { viewersPerBox, peers, mediaMbps: bitrate, dedicatedOnly, regions: used };

  if (args.has('plans')) {
    const fits = plans
      .filter((plan) => !dedicatedOnly || isDedicated(plan))
      .filter((plan) => used.every((region) => plan.locations.includes(region)))
      .map((plan) => ({ plan, capacity: capacityOf(plan, peers, bitrate) }))
      .filter((entry) => entry.capacity.viewers >= viewersPerBox)
      .sort((a, b) => a.plan.hourly_cost - b.plan.hourly_cost);
    if (args.has('json')) {
      process.stdout.write(`${JSON.stringify(fits, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(
      `plans holding ${viewersPerBox} viewers at ${peers} peers, ${bitrate} Mbps, ` +
        `in ${used.join('/')}\n\n` +
        `${'plan'.padEnd(26)}${'vCPU'.padStart(5)}${'RAM'.padStart(7)}${'holds'.padStart(7)}` +
        `${'bound'.padStart(8)}${'$/hr'.padStart(9)}\n`,
    );
    for (const { plan, capacity } of fits.slice(0, 15)) {
      process.stdout.write(
        `${plan.id.padEnd(26)}${String(plan.vcpu_count).padStart(5)}` +
          `${`${(plan.ram / 1024).toFixed(0)}G`.padStart(7)}${String(capacity.viewers).padStart(7)}` +
          `${capacity.binding.padStart(8)}${plan.hourly_cost.toFixed(4).padStart(9)}\n`,
      );
    }
    return 0;
  }

  const explicit = args.value('plan');
  const chosen =
    explicit === undefined
      ? choosePlan(plans, filter)
      : plans
          .filter((plan) => plan.id === explicit)
          .map((plan) => ({ plan, capacity: capacityOf(plan, peers, bitrate), instances: 1 }))[0];

  if (chosen === undefined) {
    process.stderr.write(
      explicit === undefined
        ? `no ${dedicatedOnly ? 'dedicated-vCPU ' : ''}plan in ${used.join('/')} holds ` +
          `${viewersPerBox} viewers at ${bitrate} Mbps. Try --shared, fewer ` +
          `--viewers-per-box, or --plans to see what is offered.\n`
        : `unknown plan ${explicit}; --plans lists what fits\n`,
    );
    return 2;
  }

  const demand = demandFor({ viewers: viewersPerBox, peers, mediaMbps: bitrate });
  const hours = 1;
  const cost = estimateCost(chosen.plan, count, hours, demand.egressGbPerHour);

  process.stdout.write(
    `plan     ${chosen.plan.id}  ${chosen.plan.vcpu_count} vCPU, ` +
      `${(chosen.plan.ram / 1024).toFixed(0)} GB, ${chosen.plan.cpu_vendor ?? '?'}` +
      `${isDedicated(chosen.plan) ? ', dedicated' : ', SHARED vCPU'}\n` +
      `fleet    ${count} x ${viewersPerBox} viewers = ${count * viewersPerBox}, ` +
      `${peers} peers each, ${bitrate} Mbps\n` +
      `regions  ${spread.join(', ')}\n` +
      `per box  ${demand.vcpu.toFixed(2)} vCPU of ${chosen.plan.vcpu_count} ` +
      `(${((100 * demand.vcpu) / chosen.plan.vcpu_count).toFixed(0)}%), ` +
      `${(demand.memBytes / 1024 ** 3).toFixed(1)} GB, ${demand.sockets} sockets, ` +
      `${demand.rxMbps.toFixed(0)}/${demand.txMbps.toFixed(0)} Mbps rx/tx\n` +
      `headroom ${chosen.capacity.viewers} viewers before ${chosen.capacity.binding} binds\n` +
      `cost/hr  $${cost.instanceUsd.toFixed(2)} instances + $${cost.egressUsd.toFixed(2)} egress ` +
      `= $${cost.totalUsd.toFixed(2)}` +
      ` (${cost.egressGb.toFixed(0)} GB out, ${cost.includedGb.toFixed(0)} GB accrued)\n`,
  );

  if (!isDedicated(chosen.plan)) {
    process.stdout.write(
      '\nwarn: shared vCPU. Steal time is invisible to the agent, so core-seconds\n' +
        '      per MB from this fleet cannot be quoted as the viewer\'s cost.\n',
    );
  }

  if (args.has('dry-run')) {
    process.stdout.write('\n--dry-run: nothing rented\n');
    return 0;
  }

  const missing = requireApiKey();
  if (missing !== undefined) {
    return missing;
  }

  const client = vultrClient();
  const key = await ensureSshKey(client, defined({ path: args.value('ssh-key') }));
  process.stdout.write(
    `\nssh key  ${key.name} (${key.localPath})${key.created ? ' — uploaded' : ''}\n\n`,
  );

  const readyTimeoutS = args.number('ready-timeout');
  const abort = new AbortController();
  const onSignal = (): void => {
    process.stderr.write('\ninterrupted: rolling back\n');
    abort.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const log = (level: 'info' | 'warn', message: string): void => {
    process.stderr.write(`provision: ${level === 'warn' ? 'warn: ' : ''}${message}\n`);
  };

  let fleet;
  try {
    fleet = await provisionFleet({
      client,
      count,
      plan: chosen.plan.id,
      regions: spread,
      sshKeyIds: [key.id],
      stateDir,
      sshUser: args.value('ssh-user') ?? DEFAULT_SSH_USER,
      signal: abort.signal,
      log,
      ...defined({ osId: args.number('os'), readyTimeoutMs: readyTimeoutS && readyTimeoutS * 1000 }),
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (args.has('json')) {
    process.stdout.write(`${JSON.stringify(fleet, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `\nfleet ${fleet.fleetId}: ${fleet.instances.length} machine(s) ready\n` +
      `${fleet.instances
        .map((instance) => `  ${instance.label.padEnd(30)} ${instance.ip.padEnd(16)} ${instance.region}`)
        .join('\n')}\n\n` +
      `run against them:\n` +
      `  npx tsx src/cli.ts run --fleet ${fleet.fleetId} \\\n` +
      `    --deploy --from-github --publish --settle \\\n` +
      `    --viewers ${count * viewersPerBox} --peers ${peers} --duration 180\n\n` +
      `give them back (do not forget — they bill by the hour):\n` +
      `  npx tsx src/cli.ts destroy --fleet ${fleet.fleetId}\n`,
  );
  return 0;
}

async function destroyCommand(args: Args): Promise<number> {
  const stateDir = args.value('state-dir') ?? DEFAULT_STATE_DIR;
  const fleetId = args.value('fleet');

  const missing = requireApiKey();
  if (missing !== undefined) {
    return missing;
  }
  const client = vultrClient();

  if (args.has('list')) {
    // From the provider, not the state directory: an instance nobody has a
    // record of is exactly the one worth showing.
    const live = await client.listInstances(FLEET_TAG);
    if (args.has('json')) {
      process.stdout.write(`${JSON.stringify(live, null, 2)}\n`);
      return 0;
    }
    if (live.length === 0) {
      process.stdout.write('no instances carrying the swarm-fleet tag\n');
      return 0;
    }
    process.stdout.write(`${live.length} instance(s):\n`);
    for (const instance of live) {
      process.stdout.write(
        `  ${instance.label.padEnd(30)} ${instance.main_ip.padEnd(16)} ` +
          `${instance.region.padEnd(5)} ${instance.plan.padEnd(24)} ${instance.date_created}\n`,
      );
    }
    const known = await listFleetStates(stateDir);
    if (known.length > 0) {
      process.stdout.write(
        `\nrecorded fleets: ${known.map((fleet) => fleet.fleetId).join(', ')}\n`,
      );
    }
    return 0;
  }

  if (fleetId === undefined && !args.has('all')) {
    process.stderr.write(
      'usage: swarm-fleet destroy --fleet <id> | --all | --list\n' +
        '  --all destroys every instance carrying the swarm-fleet tag.\n',
    );
    return 2;
  }

  const result = await destroyFleet({
    client,
    stateDir,
    ...defined({ fleetId }),
    log: (level, message) =>
      process.stderr.write(`destroy: ${level === 'warn' ? 'warn: ' : ''}${message}\n`),
  });

  if (args.has('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.failed.length === 0 ? 0 : 1;
  }
  process.stdout.write(
    `destroyed ${result.destroyed.length} instance(s)` +
      `${result.failed.length === 0 ? '' : `, ${result.failed.length} FAILED`}\n`,
  );
  for (const failure of result.failed) {
    process.stdout.write(`  ${failure.instance.label}: ${failure.error}\n`);
  }
  if (result.failed.length > 0) {
    process.stdout.write('\nthese are still billing. Retry, or delete them in the console.\n');
    return 1;
  }
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
