/**
 * A fake viewer that speaks the real contract.
 *
 * This is what makes the runner buildable and testable without mainnet and
 * without waiting on the Rust side: it emits the same NDJSON on stdout and the
 * same human text on stderr, paces itself against a clock that can be sped up,
 * and injects the failures a real viewer actually produces — the measured
 * 2-5% of segments that are not retrievable moments after publication, stalls,
 * window skips, join failures and crashes.
 *
 * It models playback the way `main.rs::play_live` does: the playhead is
 * `wall_elapsed - stalled_total`, a segment is late when it lands after the
 * playhead has consumed everything acquired before it, and the buffer is held
 * at the runway rather than racing the publisher.
 */

export interface MockIo {
  event(line: string): void;
  human(line: string): void;
  exit(code: number): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  onTerminate(handler: () => void): void;
  /**
   * Resolves when the `--hold` barrier opens, with why it opened.
   *
   * Absent means "release immediately", which is what a caller that does not
   * model the barrier wants. The real viewer reads a line on stdin here.
   */
  awaitRelease?: () => Promise<string>;
}

export interface MockConfig {
  speed: number;
  seed: number;
  segmentSeconds: number;
  segmentBytes: number;
  fetchMs: number;
  fetchJitter: number;
  stallBias: number;
  bodyFailureRate: number;
  skipRate: number;
  joinFailRate: number;
  crashAfterMs: number;
  peersRampMs: number;
  peerLimit: number;
  runwaySeconds: number;
  ignoreTerminate: boolean;
}

export interface MockArgs {
  owner: string;
  topic: string;
  live: boolean;
  segments: number;
  durationS: number | undefined;
  peerLimit: number | undefined;
  peerUp: number | undefined;
  hold: boolean;
  networkId: number;
  metricsJson: boolean;
}

export function parseMockArgs(argv: readonly string[]): MockArgs | undefined {
  if (argv[0] !== 'watch' || argv[1] === undefined || argv[2] === undefined) {
    return undefined;
  }
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const numeric = (name: string): number | undefined => {
    const raw = value(name);
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    owner: argv[1],
    topic: argv[2],
    live: argv.includes('--live'),
    segments: numeric('--segments') ?? 8,
    durationS: numeric('--duration'),
    peerLimit: numeric('--peers'),
    peerUp: numeric('--peer-up'),
    hold: argv.includes('--hold'),
    networkId: argv.includes('testnet') ? 10 : 1,
    metricsJson: value('--metrics') === 'json',
  };
}

export function mockConfigFromEnv(env: Record<string, string | undefined>): MockConfig {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    speed: Math.max(number('MOCK_SPEED', 1), 0.01),
    seed: number('MOCK_SEED', 1),
    segmentSeconds: number('MOCK_SEGMENT_SECONDS', 2),
    segmentBytes: number('MOCK_SEGMENT_BYTES', 260_000),
    fetchMs: number('MOCK_FETCH_MS', 500),
    fetchJitter: number('MOCK_FETCH_JITTER', 0.6),
    stallBias: number('MOCK_STALL_BIAS', 1),
    bodyFailureRate: number('MOCK_BODY_FAILURE_RATE', 0.03),
    skipRate: number('MOCK_SKIP_RATE', 0),
    joinFailRate: number('MOCK_JOIN_FAIL_RATE', 0),
    crashAfterMs: number('MOCK_CRASH_AFTER_MS', 0),
    peersRampMs: number('MOCK_PEERS_RAMP_MS', 8_000),
    peerLimit: number('MOCK_PEERS', 200),
    runwaySeconds: number('MOCK_RUNWAY_SECONDS', 8),
    ignoreTerminate: env['MOCK_IGNORE_SIGTERM'] === '1',
  };
}

/** xorshift32. Small, seedable, and good enough to shape a fake workload. */
function prng(seed: number): () => number {
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

export async function runMockViewer(
  argv: readonly string[],
  io: MockIo,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const args = parseMockArgs(argv);
  if (args === undefined) {
    io.human('usage: mock watch <owner> <topic> [--live] [--metrics json] ...');
    io.exit(2);
    return;
  }
  const wanted = args.segments;
  const config = mockConfigFromEnv(env);
  const random = prng(config.seed + hash(args.topic));
  const startedAt = io.now();
  const peerLimit = args.peerLimit ?? config.peerLimit;

  // Simulated milliseconds since start. `speed` compresses wall time so a
  // 200-viewer, 100-segment run is testable in seconds.
  const simMs = (): number => (io.now() - startedAt) * config.speed;
  const sleepSim = (ms: number): Promise<void> => io.sleep(ms / config.speed);

  let terminating = false;
  io.onTerminate(() => {
    if (!config.ignoreTerminate) {
      terminating = true;
    }
  });

  const emit = (event: Record<string, unknown>): void => {
    if (args.metricsJson) {
      io.event(JSON.stringify({ t: Math.round(simMs()), ...event }));
    }
  };

  emit({
    ev: 'start',
    pid: process.pid,
    network_id: args.networkId,
    mode: args.live ? 'live' : 'vod',
    owner: args.owner,
    topic: args.topic,
    peer_limit: peerLimit,
    version: 'mock-0.1.0',
  });
  io.human(`mock viewer: owner=${args.owner} topic=${args.topic} live=${args.live}`);

  if (config.crashAfterMs > 0) {
    void io.sleep(config.crashAfterMs / config.speed).then(() => {
      io.human('mock viewer: injected crash');
      io.exit(101);
    });
  }

  // Peer up. The real viewer waits for `--peer-up` peers — 25 unless a fleet
  // raises it — before asking the network for anything, and keeps dialing
  // toward its limit while it watches.
  let peers = 0;
  let dialFailures = 0;
  const peerTarget = Math.min(args.peerUp ?? 25, peerLimit);
  const peerStep = Math.max(config.peersRampMs / 10, 1);
  while (peers < peerTarget && !terminating) {
    await sleepSim(peerStep);
    peers = Math.min(peerLimit, Math.round((simMs() / config.peersRampMs) * peerLimit));
    emit({ ev: 'peers', peers, dial_failures: dialFailures });
  }
  if (terminating) {
    emitSummary();
    return;
  }

  // The barrier. Peers keep arriving while held, as they do in the real viewer:
  // the node goes on dialing toward its limit whatever the run is waiting for.
  if (args.hold) {
    const heldAt = simMs();
    emit({ ev: 'held', peers, peer_up: peerTarget });
    io.human(`mock viewer: held at ${peers} peers`);
    let reason = 'released';
    if (io.awaitRelease !== undefined) {
      const release = io.awaitRelease().then((why) => {
        reason = why;
      });
      let settled = false;
      void release.then(() => {
        settled = true;
      });
      while (!settled && !terminating) {
        await Promise.race([release, sleepSim(1_000)]);
        peers = Math.min(peerLimit, Math.round((simMs() / config.peersRampMs) * peerLimit));
        emit({ ev: 'peers', peers, dial_failures: dialFailures });
      }
    }
    emit({ ev: 'released', peers, held_ms: Math.round(simMs() - heldAt), reason });
    if (terminating) {
      emitSummary();
      return;
    }
  }

  if (random() < config.joinFailRate) {
    emit({ ev: 'error', stage: 'join', message: 'no live runway behind the edge' });
    io.human('mock viewer: join failed');
    io.exit(1);
    return;
  }

  const joinMs = simMs();
  let feedIndex = 1_000;
  emit({
    ev: 'joined',
    join_ms: Math.round(joinMs),
    feed_index: feedIndex,
    edge_sequence: 100,
    start_sequence: 96,
    runway_s: config.runwaySeconds,
    window: 10,
  });
  io.human(`mock viewer: joined in ${Math.round(joinMs)}ms`);

  // Playback, modelled on main.rs::play_live.
  const clockStart = simMs();
  const elapsed = (): number => (simMs() - clockStart) / 1000;
  let sequence = 96;
  let media = 0;
  let stalledTotal = 0;
  let stalls = 0;
  let played = 0;
  let bytes = 0;
  let bodyFailures = 0;
  let gaps = 0;
  let skipped = 0;
  const fetchSamples: number[] = [];

  const deadlineS = args.durationS;
  while (played < wanted && !terminating) {
    if (deadlineS !== undefined && elapsed() >= deadlineS) {
      break;
    }
    if (peers < peerLimit) {
      peers = Math.min(peerLimit, peers + Math.round(peerLimit / 20));
      emit({ ev: 'peers', peers, dial_failures: dialFailures });
    }

    if (config.skipRate > 0 && random() < config.skipRate) {
      const to = sequence + 3;
      emit({ ev: 'skip', from: sequence, to, reason: 'fell off the live window' });
      skipped += to - sequence;
      sequence = to;
      continue;
    }

    // Log-ish spread around the median, so the tail is fatter than the head.
    const spread = 1 + (random() - 0.5) * 2 * config.fetchJitter;
    const fetchMs = Math.max(1, config.fetchMs * spread * config.stallBias);
    await sleepSim(fetchMs);

    if (random() < config.bodyFailureRate) {
      bodyFailures += 1;
      const second = random() < 0.35;
      emit({ ev: 'body_failure', sequence, strike: second ? 2 : 1, attempts: 6 });
      if (second) {
        gaps += 1;
        emit({ ev: 'gap', sequence, source: 'local' });
        sequence += 1;
      }
      continue;
    }

    const due = media + stalledTotal;
    const now = elapsed();
    const stalled = now > due && played > 0;
    const stallS = stalled ? now - due : 0;
    if (stalled) {
      stalls += 1;
      stalledTotal += stallS;
    }

    media += config.segmentSeconds;
    const segmentBytes = Math.round(config.segmentBytes * (0.85 + random() * 0.3));
    bytes += segmentBytes;
    played += 1;
    feedIndex += 1;
    fetchSamples.push(fetchMs);

    const buffered = media - (elapsed() - stalledTotal);
    emit({
      ev: 'segment',
      sequence,
      bytes: segmentBytes,
      fetch_ms: Math.round(fetchMs),
      segment_s: config.segmentSeconds,
      buffered_s: Number(buffered.toFixed(2)),
      stalled,
      stall_s: Number(stallS.toFixed(3)),
      feed_index: feedIndex,
      attempts: 1,
      peers,
    });
    sequence += 1;

    // Hold the buffer at the runway instead of running ahead of the clock.
    const ahead = media - (elapsed() - stalledTotal);
    if (ahead > config.runwaySeconds) {
      await sleepSim((ahead - config.runwaySeconds) * 1000);
    }
  }

  emitSummary();

  function emitSummary(): void {
    const sorted = [...fetchSamples].sort((left, right) => left - right);
    const at = (q: number): number | undefined =>
      sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    emit({
      ev: 'summary',
      segments: played,
      bytes,
      media_s: Number(media.toFixed(2)),
      wall_s: Number(elapsedOrZero().toFixed(2)),
      stalls,
      stalled_s: Number(stalledTotal.toFixed(3)),
      skipped,
      gaps,
      body_failures: bodyFailures,
      fetch_ms_p50: at(0.5),
      fetch_ms_p90: at(0.9),
      fetch_ms_p99: at(0.99),
      peers,
      join_ms: Math.round(joinMs),
      feed_index: feedIndex,
      finalized: played >= wanted,
    });
    io.human(
      `mock viewer: ${played} segments, ${stalls} stalls, ${stalledTotal.toFixed(2)}s stalled`,
    );
  }

  function elapsedOrZero(): number {
    return Number.isFinite(clockStart) ? (simMs() - clockStart) / 1000 : 0;
  }
}

function hash(text: string): number {
  let value = 0;
  for (let at = 0; at < text.length; at += 1) {
    value = (value * 31 + text.charCodeAt(at)) | 0;
  }
  return Math.abs(value);
}
