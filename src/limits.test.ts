import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRaise, descriptorsNeeded, raiseCommand } from './limits.js';

test('a viewer is budgeted its peers plus slack', () => {
  assert.equal(descriptorsNeeded(20, 200), 20 * 232 + 256);
});

test('a laptop default is raised, a raised limit is left alone', () => {
  assert.equal(decideRaise(4_896, 256, 'darwin', false).raise, true);
  assert.equal(decideRaise(4_896, 1_048_576, 'darwin', false).raise, false);
});

test('it re-executes at most once, and never on Windows', () => {
  assert.equal(decideRaise(4_896, 256, 'darwin', true).raise, false);
  assert.equal(decideRaise(4_896, 256, 'win32', false).raise, false);
});

test('an unreadable limit is left alone rather than guessed at', () => {
  const decision = decideRaise(4_896, undefined, 'linux', false);
  assert.equal(decision.raise, false);
  assert.match(decision.reason, /could not read/);
});

test('the ladder falls back, and the argv survives a space in a path', () => {
  const command = raiseCommand(['/usr/local/bin/node', '/Users/a b/cli.js', 'join']);
  assert.match(command, /ulimit -n "\$\(ulimit -Hn\)".*\|\| ulimit -n 65536/s);
  assert.match(command, /exec '\/usr\/local\/bin\/node' '\/Users\/a b\/cli\.js' 'join'$/);
});
