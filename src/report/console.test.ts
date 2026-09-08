import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSnapshot } from '../controller.js';
import { agentLine } from './console.js';

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

test('a machine line carries what would end a run', () => {
  const line = agentLine(snapshot());
  assert.match(line, /^box-a\s+18\/20\s+23\.4%\s+1\.8\/8\s+14\.0%\s+12\.9\/0\.4\s+3612$/);
});

test('a machine that has not been sampled shows dashes, not zeros', () => {
  // "We did not measure that" and "that was zero" are different facts, and a
  // zero here would read as an idle machine.
  const line = agentLine({
    name: 'box-b',
    host: 'box-b',
    target: 0,
    active: 0,
    bootstrapping: 0,
  });
  assert.match(line, /^box-b\s+0\/0\s+-\s+-\s+-\s+-\s+-$/);
});

test('bootstrapping viewers are counted apart from running ones', () => {
  // A box holding 4 viewers of which 3 are still dialing is not a box holding
  // 4 viewers, and admission control is the reason to be able to see it.
  const line = agentLine(snapshot({ active: 4, target: 20, bootstrapping: 3 }));
  assert.match(line, /4\/20\+3/);
});

test('a breach on a machine displaces its admission note', () => {
  const held = agentLine(snapshot({ admissionReason: 'cpu budget spent' }));
  assert.match(held, /cpu budget spent$/);

  const breached = agentLine(
    snapshot({ admissionReason: 'cpu budget spent', breachedGuard: 'cpu_headroom' }),
  );
  assert.match(breached, /BREACHED cpu_headroom$/);
  assert.doesNotMatch(breached, /cpu budget/);
});
