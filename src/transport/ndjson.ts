/** Newline-delimited JSON framing over a pair of byte streams. */

import type { Readable, Writable } from 'node:stream';
import type { ZodType, ZodTypeDef } from 'zod';
import { type Channel, MessageQueue } from './channel.js';

/** A control line longer than this means framing has gone wrong. */
const MAX_LINE_BYTES = 8 << 20;

export interface NdjsonOptions<Inbound> {
  input: Readable;
  output: Writable;
  /** Input side is `unknown`: these schemas apply defaults, so in and out differ. */
  schema: ZodType<Inbound, ZodTypeDef, unknown>;
  onMalformed?: (line: string, reason: string) => void;
}

export function ndjsonChannel<Outbound, Inbound>(
  options: NdjsonOptions<Inbound>,
): Channel<Outbound, Inbound> {
  const { input, output, schema, onMalformed } = options;
  const queue = new MessageQueue<Inbound>();
  const closeHandlers: ((reason?: string) => void)[] = [];
  let closed = false;
  let pending = '';

  const fail = (reason?: string): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const handler of closeHandlers) {
      handler(reason);
    }
  };

  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim().length > 0) {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          onMalformed?.(line, 'not json');
          newline = pending.indexOf('\n');
          continue;
        }
        const parsed = schema.safeParse(json);
        if (parsed.success) {
          queue.deliver(parsed.data);
        } else {
          onMalformed?.(line, parsed.error.issues[0]?.message ?? 'schema');
        }
      }
      newline = pending.indexOf('\n');
    }
    if (pending.length > MAX_LINE_BYTES) {
      onMalformed?.('', 'control line exceeded the frame limit');
      pending = '';
    }
  });
  input.on('end', () => fail('stream ended'));
  input.on('error', (error: Error) => fail(error.message));
  output.on('error', (error: Error) => fail(error.message));

  return {
    send: (message) => {
      if (!closed) {
        output.write(`${JSON.stringify(message)}\n`);
      }
    },
    onMessage: (handler) => queue.attach(handler),
    onClose: (handler) => closeHandlers.push(handler),
    close: () => fail('closed locally'),
  };
}
