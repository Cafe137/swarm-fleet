import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  controllerClockSuspect,
  evaluateGuards,
  guardsValid,
  GUARD_SUSTAIN_SAMPLES,
} from './guard.js';
import type { MachineInfo, MachineSample } from '../transport/protocol.js';

const machine: MachineInfo = {
  hostname: 'box',
  platform: 'linux',
  arch: 'x64',
  cores: 8,
  totalMemBytes: 16 * 1024 ** 3,
  nodeVersion: 'v24.0.0',
};

function sample(overrides: Partial<MachineSample> = {}): MachineSample {
  return {
    atMs: 0,
    loadAvg1: 1,
    loadAvg5: 1,
    freeMemBytes: 8 * 1024 ** 3,
    agentRssBytes: 60 * 1024 * 1024,
    samplerLagMs: 5,
    viewerRssTotalBytes: 1024 ** 3,
    ...overrides,
  };
}

function guards(overrides: {
  samples?: MachineSample[];
  startTimestamps?: number[];
  dialFailureSeries?: number[];
  bootstrappingSeries?: number[];
  clockOffsetMs?: number;
  clockRttMs?: number;
  admissionDisabled?: boolean;
  measuredFromMs?: number;
}) {
  return evaluateGuards({
    machine,
    samples: overrides.samples ?? [sample(), sample(), sample(), sample()],
    startTimestamps: overrides.startTimestamps ?? [0, 300, 600, 900],
    minStartIntervalMs: 250,
    admissionDisabled: overrides.admissionDisabled ?? false,
    clockOffsetMs: overrides.clockOffsetMs ?? 2,
    dialFailureSeries: overrides.dialFailureSeries ?? [0, 0, 0, 0],
    ...(overrides.bootstrappingSeries === undefined
      ? {}
      : { bootstrappingSeries: overrides.bootstrappingSeries }),
    ...(overrides.clockRttMs === undefined ? {} : { clockRttMs: overrides.clockRttMs }),
    ...(overrides.measuredFromMs === undefined
      ? {}
      : { measuredFromMs: overrides.measuredFromMs }),
  });
}

function verdict(name: string, overrides: Parameters<typeof guards>[0]) {
  const found = guards(overrides).find((entry) => entry.name === name);
  assert.ok(found !== undefined, `no ${name} verdict`);
  return found;
}

test('a healthy machine passes every guard', () => {
  const verdicts = guards({});
  assert.equal(guardsValid(verdicts), true);
});

test('cpu load has to stay high to count, not merely spike', () => {
  const spike = [sample(), sample({ loadAvg1: 20 }), sample(), sample()];
  assert.equal(verdict('cpu_headroom', { samples: spike }).status, 'ok');

  const sustained = Array.from({ length: GUARD_SUSTAIN_SAMPLES }, (_, at) =>
    sample({ atMs: at * 1_000, loadAvg1: 20 }),
  );
  const breached = verdict('cpu_headroom', { samples: sustained });
  assert.equal(breached.status, 'breached');
  assert.equal(breached.firstBreachAtMs, 0);
});

test('a settled run is judged on its measurement window, not on its join burst', () => {
  // A 6-core box at 99.6% while 20 viewers dial 200 peers each, then a quiet
  // measurement. Measured, on 192.99.166.13.
  const settling = [0, 1, 2, 3].map((at) => sample({ atMs: at * 1_000, loadAvg1: 20 }));
  const measuring = [4, 5, 6, 7].map((at) => sample({ atMs: at * 1_000, loadAvg1: 1 }));
  const samples = [...settling, ...measuring];

  // Unscoped, the burst fails the run and the numbers it protects were never
  // affected by it.
  assert.equal(verdict('cpu_headroom', { samples }).status, 'breached');

  const scoped = verdict('cpu_headroom', { samples, measuredFromMs: 4_000 });
  assert.equal(scoped.status, 'ok');
  assert.equal(scoped.value, 1);
  assert.match(scoped.detail, /4 settle-phase samples excluded/);

  // Saturation *inside* the window still fails, whatever the settle phase did.
  const stillBusy = [...settling, ...[4, 5, 6, 7].map((at) => sample({ atMs: at * 1_000, loadAvg1: 20 }))];
  assert.equal(
    verdict('cpu_headroom', { samples: stillBusy, measuredFromMs: 4_000 }).status,
    'breached',
  );

  // Memory is deliberately not scoped: a peak RSS is a peak RSS.
  const heavy = settling.map((entry) => ({ ...entry, viewerRssTotalBytes: 15 * 1024 ** 3 }));
  assert.equal(
    verdict('memory_headroom', { samples: [...heavy, ...measuring], measuredFromMs: 4_000 }).status,
    'breached',
  );
});

test('memory is judged on tracked RSS, not on free memory', () => {
  // 14 GiB of viewers on a 16 GiB box is past the 80% line.
  const heavy = Array.from({ length: 4 }, () =>
    sample({ viewerRssTotalBytes: 14 * 1024 ** 3, freeMemBytes: 0 }),
  );
  assert.equal(verdict('memory_headroom', { samples: heavy }).status, 'breached');

  // darwin reports almost no free memory when idle; that must not be a breach.
  const idleMac = Array.from({ length: 4 }, () =>
    sample({ freeMemBytes: 100 * 1024 * 1024, viewerRssTotalBytes: 1024 ** 3 }),
  );
  assert.equal(verdict('memory_headroom', { samples: idleMac }).status, 'ok');
});

test('dial failures breach when they rise, not when they merely exist', () => {
  assert.equal(verdict('dial_failures', { dialFailureSeries: [3, 3, 3, 3, 3] }).status, 'ok');
  assert.equal(verdict('dial_failures', { dialFailureSeries: [0, 1, 4, 9, 20] }).status, 'breached');
});

test('starts crowded closer than the floor breach the stagger guard', () => {
  assert.equal(verdict('stagger_adherence', { startTimestamps: [0, 300, 600] }).status, 'ok');
  assert.equal(
    verdict('stagger_adherence', { startTimestamps: [0, 1, 2, 3, 4, 5] }).status,
    'breached',
  );
});

test('flood makes the stagger guard inapplicable rather than failed', () => {
  const flood = verdict('stagger_adherence', {
    startTimestamps: [0, 1, 2, 3],
    admissionDisabled: true,
  });
  assert.equal(flood.status, 'not_applicable');
  assert.equal(guardsValid(guards({ startTimestamps: [0, 1, 2, 3], admissionDisabled: true })), true);
});

test('a sampler that cannot keep time invalidates the run', () => {
  const late = Array.from({ length: 4 }, () => sample({ samplerLagMs: 900 }));
  assert.equal(verdict('sampler_jitter', { samples: late }).status, 'breached');
});

test('clock skew is reported only past a full second', () => {
  // Sub-second drift cannot move a published figure: the offset is applied to
  // two fields per viewer, and every judged number is viewer- or
  // controller-local. A laptop 111 ms off NTP used to fail the run for it.
  assert.equal(verdict('clock_skew', { clockOffsetMs: 20 }).status, 'ok');
  assert.equal(verdict('clock_skew', { clockOffsetMs: -400 }).status, 'ok');
  assert.equal(verdict('clock_skew', { clockOffsetMs: 111 }).status, 'ok');
  // A second or more is a clock that is actually wrong.
  assert.equal(verdict('clock_skew', { clockOffsetMs: 1_500 }).status, 'breached');
  assert.equal(verdict('clock_skew', { clockOffsetMs: -4_000 }).status, 'breached');
  // The offset is still reported when it is not a breach: the measurement is
  // worth having even when it is nobody's problem.
  assert.match(verdict('clock_skew', { clockOffsetMs: 111 }).detail, /111\.0 ms/);
});

test('agent overhead is recorded but never a reason to fail', () => {
  const fat = Array.from({ length: 4 }, () => sample({ agentRssBytes: 4 * 1024 ** 3 }));
  assert.equal(verdict('agent_overhead', { samples: fat }).status, 'ok');
});

test('no samples is no data, which is not the same as ok', () => {
  const empty = guards({ samples: [] });
  assert.equal(empty.find((entry) => entry.name === 'cpu_headroom')?.status, 'no_data');
});

test('dial failures rising while viewers are still joining prove nothing', () => {
  // A staggered cohort adds a viewer dialing 200 peers every few hundred
  // milliseconds, so failures rise for the whole ramp. This fired on a real
  // 4-viewer run holding 805 sockets against 28,000 available ports.
  const rising = [0, 4, 20, 60, 92];
  assert.equal(
    verdict('dial_failures', {
      dialFailureSeries: rising,
      bootstrappingSeries: [1, 2, 2, 1, 1],
    }).status,
    'no_data',
  );

  // The same growth after everything has joined is the signal it exists for.
  assert.equal(
    verdict('dial_failures', {
      dialFailureSeries: rising,
      bootstrappingSeries: [0, 0, 0, 0, 0],
    }).status,
    'breached',
  );

  // Mixed: the ramp is skipped, and the settled tail is judged on its own.
  assert.equal(
    verdict('dial_failures', {
      dialFailureSeries: [0, 30, 60, 61, 61, 61],
      bootstrappingSeries: [2, 2, 1, 0, 0, 0],
    }).status,
    'ok',
  );
});

test('a remote clock is not judged more precisely than the link allows', () => {
  // Half the round trip is the best a request and a reply can pin a clock to,
  // so a slow link raises the bar above the threshold rather than below it.
  assert.equal(verdict('clock_skew', { clockOffsetMs: 1_500, clockRttMs: 4_000 }).status, 'ok');
  assert.equal(verdict('clock_skew', { clockOffsetMs: 1_500, clockRttMs: 20 }).status, 'breached');
  // On any ordinary link the threshold governs, not the round trip.
  assert.equal(verdict('clock_skew', { clockOffsetMs: 900, clockRttMs: 2 }).status, 'ok');
  assert.match(
    verdict('clock_skew', { clockOffsetMs: 10, clockRttMs: 80 }).detail,
    /no better than 40 ms/,
  );
});

test('agents that agree on the offset are not the ones with the wrong clock', () => {
  // The shape of the first real remote run — the agent 1.9 us off NTP by its
  // own chrony, the whole offset belonging to the controller's laptop — but at
  // a magnitude that is now worth reporting.
  assert.equal(controllerClockSuspect([1_730, 1_710, 1_760]), true);
  assert.equal(controllerClockSuspect([-1_730, -1_710]), true);
  // One agent proves nothing: a difference cannot say which side drifted.
  assert.equal(controllerClockSuspect([1_730]), false);
  // Disagreement means the agents are the problem, individually.
  assert.equal(controllerClockSuspect([1_730, -1_710]), false);
  assert.equal(controllerClockSuspect([1_730, 6_000]), false);
  // Agreement is judged on the link's own error, not on the drift threshold:
  // two agents a second apart are not agreeing, however large both offsets are.
  assert.equal(controllerClockSuspect([1_100, 2_000]), false);
  // Below the reporting threshold there is no problem to attribute at all.
  assert.equal(controllerClockSuspect([73, 71, 76]), false);
  assert.equal(controllerClockSuspect([2, 3]), false);
});
