import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSnapshot, LiveSnapshot } from '../controller.js';
import { ConsoleView, clip, fleetTable, machineCells, machineTable, visibleWidth } from './console.js';

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    name: 'box-a',
    host: 'box-a.internal',
    target: 20,
    active: 18,
    bootstrapping: 0,
    cores: 8,
    cpuUtilisation: 0.234,
    loadAvg1: 1.84,
    memUsedFraction: 0.14,
    viewerRssBytes: 640 * 1024 * 1024,
    rxMbps: 12.94,
    txMbps: 0.42,
    establishedSockets: 3612,
    ...overrides,
  };
}

const visible = visibleWidth;

function live(agents: AgentSnapshot[]): LiveSnapshot {
  return {
    elapsedS: 213,
    target: 50,
    active: 50,
    bootstrapping: 3,
    started: 50,
    exited: 0,
    joined: 47,
    degradedFraction: 0.6,
    stallRatioP95: 0.243,
    realtimeFactorP95: 0.81,
    windowMbps: 135,
    segments: 4523,
    bytes: 3055 * 1024 * 1024,
    guardsOk: false,
    agents,
  };
}

/** A terminal that records what was written to it. */
function fakeTty(columns: number): NodeJS.WriteStream & { written: string[] } {
  const written: string[] = [];
  return {
    columns,
    isTTY: true,
    write(text: string): boolean {
      written.push(text);
      return true;
    },
    written,
  } as unknown as NodeJS.WriteStream & { written: string[] };
}

test('a machine line carries what would end a run', () => {
  const cells = machineCells(snapshot());
  assert.deepEqual(cells, {
    host: 'box-a',
    viewers: '18/20',
    bootstrapping: '0',
    held: '-',
    cpu: '23.4%',
    load: '1.8/8',
    mem: '14.0%',
    net: '12.9/0.4',
    sockets: '3612',
    note: '',
  });
});

test('a machine that has not been sampled shows dashes, not zeros', () => {
  // "We did not measure that" and "that was zero" are different facts, and a
  // zero here would read as an idle machine.
  const cells = machineCells({
    name: 'box-b',
    host: 'box-b',
    target: 0,
    active: 0,
    bootstrapping: 0,
  });
  assert.equal(cells.cpu, '-');
  assert.equal(cells.load, '-');
  assert.equal(cells.mem, '-');
  assert.equal(cells.net, '-');
  assert.equal(cells.sockets, '-');
});

test('bootstrapping viewers get their own column, not a "+n" suffix', () => {
  // A box holding 25 viewers of which 25 are still dialing is not a box holding
  // 50, which is what `25/25+25` looked like. The count is a subset of the
  // active viewers, so it cannot share their cell.
  const cells = machineCells(snapshot({ active: 25, target: 25, bootstrapping: 25 }));
  assert.equal(cells.viewers, '25/25');
  assert.equal(cells.bootstrapping, '25');
});

test('a breach on a machine displaces its admission note', () => {
  assert.equal(machineCells(snapshot({ admissionReason: 'cpu budget spent' })).note, 'cpu budget spent');
  assert.equal(
    machineCells(snapshot({ admissionReason: 'cpu budget spent', breachedGuard: 'cpu_headroom' }))
      .note,
    'BREACHED cpu_headroom',
  );
});

test('no table row is wider than the terminal', () => {
  // The redraw moves the cursor up by the number of lines it printed, so a line
  // that wraps leaves a row behind on every frame. That was the bug: an ssh
  // hostname is 20 characters and the columns ran off the end. The addresses
  // are RFC 5737 documentation ranges, at the lengths that provoked it.
  const agents = [
    snapshot({ name: 'root@198.51.100.149', bootstrapping: 5 }),
    snapshot({ name: 'debian@198.51.100.13', breachedGuard: 'cpu_headroom' }),
  ];
  for (const width of [38, 40, 60, 80, 120, 200]) {
    for (const line of machineTable(agents, width)) {
      assert.ok(
        visible(line) <= width,
        `at width ${width} a row came out ${visible(line)} wide: ${line}`,
      );
    }
  }
});

test('a narrow terminal loses columns rather than alignment', () => {
  const agents = [snapshot({ name: 'root@198.51.100.149' })];
  const wide = machineTable(agents, 200).join('\n');
  const narrow = machineTable(agents, 46).join('\n');
  assert.match(wide, /sockets/);
  assert.doesNotMatch(narrow, /sockets/);
  // Host, viewers, cpu and the note survive at any width: a row without them
  // says nothing that could be acted on.
  assert.match(narrow, /host/);
  assert.match(narrow, /viewers/);
  assert.match(narrow, /cpu/);
  assert.match(narrow, /note/);
});

test('a long hostname is truncated, not allowed to shift the columns', () => {
  const long = machineTable([snapshot({ name: 'ubuntu@ec2-203-0-113-42.eu-west-1.compute.internal' })], 200);
  const widths = new Set(long.map((line) => visible(line)));
  assert.equal(widths.size, 1, `rows disagreed on width: ${[...widths].join(', ')}`);
  assert.match(long.join('\n'), /…/);
});

test('clipping counts characters, not colour codes', () => {
  const coloured = `${'\u001b[31m'}abcdef${'\u001b[0m'}`;
  assert.equal(visible(clip(coloured, 3)), 3);
  assert.equal(clip(coloured, 100), coloured);
});

test('the fleet table gives up columns rather than running off the screen', () => {
  const snapshot = live([]);
  for (const width of [40, 60, 90, 200]) {
    for (const line of fleetTable(snapshot, width)) {
      assert.ok(visible(line) <= width, `at width ${width}: ${visible(line)} wide`);
    }
  }
  // The headline KPI, its leading indicator and the verdict are never given up.
  const narrow = fleetTable(snapshot, 40).join('\n');
  assert.match(narrow, /degraded/);
  assert.match(narrow, /realtime p95/);
  assert.match(narrow, /guards/);
});

test('the block moves the cursor up by exactly the rows it printed', () => {
  // The whole redraw rests on this: one extra wrapped row per frame and the
  // block marches down the screen, leaving a copy of its top line behind. The
  // old view did exactly that as soon as an ssh hostname arrived.
  const out = fakeTty(70);
  const view = new ConsoleView({ out, interactive: true, durationS: 300 });
  const snapshot = live([
    {
      name: 'root@198.51.100.149',
      host: 'root@198.51.100.149',
      target: 25,
      active: 25,
      bootstrapping: 3,
      cores: 8,
      cpuUtilisation: 0.118,
      loadAvg1: 2.2,
      memUsedFraction: 0.043,
      rxMbps: 79.6,
      txMbps: 24.3,
    },
  ]);

  view.render(snapshot);
  const first = out.written.join('');
  const rows = first.split('\n').length - 1;
  for (const line of first.split('\n')) {
    assert.ok(visible(line) <= 70, `printed a line ${visible(line)} wide into a 70-column terminal`);
  }

  out.written.length = 0;
  view.render(snapshot);
  const redraw = out.written.join('');
  assert.ok(
    redraw.startsWith(`\u001b[${rows}A\u001b[0J`),
    `expected the frame to rewind ${rows} rows, got ${JSON.stringify(redraw.slice(0, 12))}`,
  );
});

test('a log is written where the block is, so the next frame redraws below it', () => {
  const out = fakeTty(100);
  const view = new ConsoleView({ out, interactive: true });
  view.render(live([]));
  const rows = out.written.join('').split('\n').length - 1;

  out.written.length = 0;
  view.log('warn: agent box-a fell behind');
  const logged = out.written.join('');
  assert.ok(logged.startsWith(`\u001b[${rows}A\u001b[0J`), 'the log did not erase the block first');
  assert.match(logged, /agent box-a fell behind/);

  // And the frame after it owns nothing, so it must not rewind over the log.
  out.written.length = 0;
  view.render(live([]));
  assert.doesNotMatch(out.written.join(''), /\u001b\[\d+A/);
});

test('outside a terminal it stays one line, and not every second', () => {
  const out = fakeTty(100);
  const view = new ConsoleView({ out, interactive: false });
  view.render(live([]));
  view.render(live([]));
  const lines = out.written.join('').trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /^t=213s {2}viewers 50\/50/);
  assert.doesNotMatch(lines[0] as string, /\u001b/);
});
