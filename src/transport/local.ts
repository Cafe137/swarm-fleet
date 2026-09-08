/**
 * In-process transport, for single-box runs and for tests.
 *
 * The controller drives the same code path here as it does over SSH, which is
 * the point: a local run is not a special case, it is a fleet of one.
 *
 * A local agent does perturb the machine it measures — Node's own footprint
 * lands in the same CPU and memory budget as the viewers. That is recorded in
 * `run.json` and reported, and it is why a real run keeps the controller on a
 * different machine.
 */

import type { FromAgent, ToAgent } from './protocol.js';
import { type Channel, MessageQueue } from './channel.js';

export interface LocalPair {
  controllerSide: Channel<ToAgent, FromAgent>;
  agentSide: Channel<FromAgent, ToAgent>;
}

export function localChannelPair(): LocalPair {
  const toAgent = new MessageQueue<ToAgent>();
  const toController = new MessageQueue<FromAgent>();
  const closeHandlers: { controller: (() => void)[]; agent: (() => void)[] } = {
    controller: [],
    agent: [],
  };
  let closed = false;

  const closeBoth = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    // Defer so a `close()` inside a message handler does not re-enter it.
    setImmediate(() => {
      for (const handler of closeHandlers.controller) {
        handler();
      }
      for (const handler of closeHandlers.agent) {
        handler();
      }
    });
  };

  return {
    controllerSide: {
      send: (message) => {
        if (!closed) {
          // Asynchronous, so the local transport has the same reentrancy
          // properties as a pipe and a bug cannot hide behind synchronous
          // delivery until the day it runs over SSH.
          setImmediate(() => toAgent.deliver(message));
        }
      },
      onMessage: (handler) => toController.attach(handler),
      onClose: (handler) => closeHandlers.controller.push(handler),
      close: closeBoth,
    },
    agentSide: {
      send: (message) => {
        if (!closed) {
          setImmediate(() => toController.deliver(message));
        }
      },
      onMessage: (handler) => toAgent.attach(handler),
      onClose: (handler) => closeHandlers.agent.push(handler),
      close: closeBoth,
    },
  };
}
