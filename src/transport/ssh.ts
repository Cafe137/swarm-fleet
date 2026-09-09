/**
 * Agents over SSH stdio.
 *
 * No ports to open, no listener to authenticate, no service to install:
 * existing SSH keys are the whole auth story. Designing authentication for a
 * program whose purpose is to generate load is a bad thing to get wrong, and
 * at ~100 control messages a second per machine there is no throughput reason
 * to want a socket.
 *
 * The remote agent dies when this pipe closes, so a killed controller cannot
 * leave viewers holding mainnet connections.
 */

import { spawn } from 'node:child_process';
import type { Channel } from './channel.js';
import { ndjsonChannel } from './ndjson.js';
import { FromAgent, type ToAgent } from './protocol.js';

export interface SshTarget {
  host: string;
  user?: string | undefined;
  port?: number | undefined;
  identity?: string | undefined;
  /** Command that starts the agent on the remote machine. */
  command?: string | undefined;
  /**
   * A box this rig created minutes ago and will destroy after the run.
   *
   * Skips the known_hosts dance, which on a provisioned fleet is not security
   * but an outage: `BatchMode=yes` turns the first-contact prompt into a hard
   * failure, so every freshly created instance would refuse to connect. And
   * cloud providers recycle addresses, so the second fleet to land on an IP
   * inherits the first one's key and fails the *other* way.
   *
   * Trust-on-first-use buys nothing here in any case: we learned this address
   * from an authenticated API call to the provider that created the host
   * seconds earlier. Off by default — a machine someone else administers gets
   * the normal checks.
   */
  ephemeralHost?: boolean | undefined;
}

export const DEFAULT_REMOTE_COMMAND = 'swarm-fleet agent --stdio';

export interface SshConnection {
  channel: Channel<ToAgent, FromAgent>;
  argv: string[];
  kill(): void;
}

/**
 * `ssh` arguments for one target, up to but not including the remote command.
 *
 * Shared with the deploy path so a host that the controller can reach is a host
 * the deployer can reach: one set of connection options, one place to be wrong.
 */
export function sshArgs(target: SshTarget): string[] {
  const args = [
    // Never prompt: an interactive password prompt inside a fleet launch is a
    // hang, not a login.
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ExitOnForwardFailure=yes',
  ];
  if (target.ephemeralHost === true) {
    args.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null');
    // Otherwise every connection prints a warning banner onto the agent's
    // stderr, which the controller logs as though the agent had said it.
    args.push('-o', 'LogLevel=ERROR');
  }
  if (target.port !== undefined) {
    args.push('-p', String(target.port));
  }
  if (target.identity !== undefined) {
    args.push('-i', target.identity);
  }
  args.push(target.user === undefined ? target.host : `${target.user}@${target.host}`);
  return args;
}

export function sshChannel(
  target: SshTarget,
  onStderr: (line: string) => void,
  onMalformed: (line: string, reason: string) => void,
): SshConnection {
  const args = sshArgs(target);
  args.push('--', target.command ?? DEFAULT_REMOTE_COMMAND);

  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  child.stderr?.setEncoding('utf8');
  let pending = '';
  child.stderr?.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.length > 0) {
        onStderr(line);
      }
      newline = pending.indexOf('\n');
    }
  });

  const channel = ndjsonChannel<ToAgent, FromAgent>({
    input: child.stdout as NonNullable<typeof child.stdout>,
    output: child.stdin as NonNullable<typeof child.stdin>,
    schema: FromAgent,
    onMalformed,
  });

  return {
    channel,
    argv: ['ssh', ...args],
    kill: () => {
      // Closing stdin is the agent's shutdown signal; the kill is the backstop.
      child.stdin?.end();
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    },
  };
}
