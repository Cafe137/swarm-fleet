#!/usr/bin/env node
/**
 * Entry point for the fake viewer, so it can be spawned as a process exactly
 * the way the native binary is. `--binary mock` in a scenario resolves here.
 */

import { runMockViewer } from './viewer.js';

const argv = process.argv.slice(2);
const args = argv[0] === 'mock' ? argv.slice(1) : argv;

let terminate: (() => void) | undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    process.stderr.write(`mock viewer: ${signal}, finishing and reporting\n`);
    terminate?.();
  });
}

await runMockViewer(args, {
  event: (line) => process.stdout.write(`${line}\n`),
  human: (line) => process.stderr.write(`${line}\n`),
  exit: (code) => process.exit(code),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  onTerminate: (handler) => {
    terminate = handler;
  },
});
process.exit(0);
