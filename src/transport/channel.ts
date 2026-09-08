/** A bidirectional message channel. The two transports both provide this. */
export interface Channel<Outbound, Inbound> {
  send(message: Outbound): void;
  onMessage(handler: (message: Inbound) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}

/** Buffers messages that arrive before a handler is attached. */
export class MessageQueue<T> {
  private handler: ((message: T) => void) | undefined;
  private readonly pending: T[] = [];

  attach(handler: (message: T) => void): void {
    this.handler = handler;
    while (this.pending.length > 0) {
      handler(this.pending.shift() as T);
    }
  }

  deliver(message: T): void {
    if (this.handler === undefined) {
      this.pending.push(message);
      return;
    }
    this.handler(message);
  }
}
