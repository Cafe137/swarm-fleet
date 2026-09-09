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
  // The same barrier the native viewer implements: one line on stdin. A closed
  // stdin releases too, so a mock spawned without the pipe is not stuck.
  awaitRelease: () =>
    new Promise<string>((resolve) => {
      let seen = false;
      const done = (why: string): void => {
        if (!seen) {
          seen = true;
          process.stdin.pause();
          resolve(why);
        }
      };
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', () => done('released on stdin'));
      process.stdin.on('end', () => done('stdin closed'));
      process.stdin.on('error', () => done('stdin unreadable'));
      process.stdin.resume();
    }),
});
process.exit(0);
