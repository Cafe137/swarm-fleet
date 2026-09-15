/**
 * The client half of the backend API.
 *
 * Everything here tolerates a backend that is down, slow, or has been
 * restarted. That is not defensive habit: the whole point of a participant's
 * machine is the load it puts on Swarm, and losing the scoreboard is no reason
 * to stop generating it.
 *
 * So failure is a value rather than an exception, and it says *which* failure,
 * because the three answers need three different behaviours:
 *
 * -   **unreachable** — carry on watching and try again in fifteen seconds.
 * -   **rejoin** — the server does not know this session any more, which is
 *     what a backend restarted against a fresh data directory looks like. The
 *     load is still real; it is the identity that has to be renewed, and a
 *     client that treated this as "offline" would vanish from the leaderboard
 *     for the rest of the event while still hammering Swarm.
 * -   **not ready** — there is no live stream to watch yet. Only `join` can
 *     say this, and only waiting fixes it.
 */

import {
  API,
  JoinRequest,
  JoinResponse,
  type LoadtestReport,
  ReportResponse,
} from './protocol.js';

const JOIN_TIMEOUT_MS = 20_000;
const REPORT_TIMEOUT_MS = 10_000;

export interface BackendOptions {
  /** Base URL of the backend, e.g. `https://loadtest.example.org`. */
  base: string;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * A join that did not happen, and whether waiting would help.
 *
 * `retryable` is true for a backend that is starting up, publishing a stream
 * that has not reached a joinable window yet, or simply not answering — all of
 * which resolve themselves within a minute or two of an event beginning, which
 * is exactly when everyone types the command at once.
 */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export type ReportOutcome =
  | { kind: 'ok'; response: ReportResponse }
  | { kind: 'rejoin'; detail: string }
  | { kind: 'unreachable'; detail: string };

export class Backend {
  private readonly base: string;
  private readonly http: typeof fetch;

  constructor(options: BackendOptions) {
    this.base = options.base.replace(/\/+$/, '');
    this.http = options.fetchImpl ?? fetch;
  }

  get origin(): string {
    return this.base;
  }

  async join(request: JoinRequest): Promise<JoinResponse> {
    const payload = await this.post(API.join, JoinRequest.parse(request), JOIN_TIMEOUT_MS);
    try {
      return JoinResponse.parse(payload);
    } catch {
      throw new BackendError(`${this.base} did not answer with a join`, undefined, false);
    }
  }

  /**
   * Send one report, and take back whatever the server wants to say.
   *
   * Never throws. The caller shows the outcome on screen and keeps running: a
   * participant whose laptop cannot see the scoreboard is still a participant.
   */
  async report(report: LoadtestReport): Promise<ReportOutcome> {
    try {
      const payload = await this.post(API.report, report, REPORT_TIMEOUT_MS);
      return { kind: 'ok', response: ReportResponse.parse(payload) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 409 is the server saying it has never heard of this session; 404 and
      // 410 are what a differently configured deployment would say for the
      // same thing. All three are cured by joining again, and nothing else is.
      const status = error instanceof BackendError ? error.status : undefined;
      return status === 409 || status === 404 || status === 410
        ? { kind: 'rejoin', detail }
        : { kind: 'unreachable', detail };
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.http(`${this.base}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // No answer at all: the server is not up yet, the laptop is between
      // wireless networks, the hotel captive portal ate it. All worth retrying.
      throw new BackendError(
        `${this.base}${path} could not be reached (${
          error instanceof Error ? error.message : String(error)
        })`,
        undefined,
        true,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BackendError(
        `${this.base}${path} answered ${response.status}${
          text === '' ? '' : `: ${describe(text)}`
        }`,
        response.status,
        response.status === 503 || response.status >= 500,
      );
    }
    return response.json();
  }
}

/** The server's own words when it sends any, trimmed to one line. */
function describe(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    // Not JSON; show the first of whatever it was.
  }
  return text.slice(0, 200);
}
