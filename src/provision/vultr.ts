/**
 * The Vultr API v2, as much of it as renting load generators needs.
 *
 * Written against `fetch` rather than a vendor SDK on purpose: the surface used
 * here is six endpoints, and a dependency that ships its own HTTP stack into a
 * 0.5 MB agent tarball costs more than it saves. `deploy` already refuses to
 * carry the 11 MB Swarm SDK for the same reason.
 *
 * Two facts about the provider shape the client:
 *
 * **Rate limit is 30 calls/second.** Polling forty instances one at a time
 * would spend it on nothing, so readiness reads the whole tagged fleet in one
 * `GET /v2/instances?tag=…` and the caller filters. `minIntervalMs` is the
 * backstop for everything else.
 *
 * **`plans` and `regions` need no key.** They are fetched to *size* a fleet
 * before an account exists, which is why `listPlans` and `listRegions` are
 * callable on a client with no API key and every other method is not.
 */

import { z } from 'zod';

export const VULTR_API = 'https://api.vultr.com/v2';

/**
 * Vultr bills a month as 672 hours and accrues transfer allowance hourly
 * against that, rather than reconciling at month end. An instance that lives
 * one hour therefore earns 1/672nd of its plan's monthly `bandwidth` and pays
 * $0.01/GB on everything beyond it — which is most of what a load generator
 * sends. See `sizing.ts`, which is where that arithmetic is done.
 */
export const VULTR_BILLING_HOURS_PER_MONTH = 672;
export const VULTR_OVERAGE_USD_PER_GB = 0.01;

export const VultrPlan = z.object({
  id: z.string(),
  vcpu_count: z.number(),
  /** Megabytes. */
  ram: z.number(),
  disk: z.number(),
  /** Gigabytes of transfer per month, accrued hourly. */
  bandwidth: z.number(),
  monthly_cost: z.number(),
  hourly_cost: z.number(),
  /** Plan family: `voc` is Optimized (dedicated vCPU), the rest are shared. */
  type: z.string(),
  cpu_vendor: z.string().optional(),
  locations: z.array(z.string()).default([]),
});
export type VultrPlan = z.infer<typeof VultrPlan>;

export const VultrRegion = z.object({
  id: z.string(),
  city: z.string(),
  country: z.string(),
  continent: z.string(),
});
export type VultrRegion = z.infer<typeof VultrRegion>;

export const VultrInstance = z.object({
  id: z.string(),
  label: z.string().default(''),
  region: z.string().default(''),
  plan: z.string().default(''),
  /** `0.0.0.0` until an address is assigned, which is not immediate. */
  main_ip: z.string().default(''),
  /** `pending` while it builds, then `active`. */
  status: z.string().default(''),
  /** `none` | `locked` | `installingbooting` | `ok`. */
  server_status: z.string().default(''),
  power_status: z.string().default(''),
  date_created: z.string().default(''),
  tags: z.array(z.string()).default([]),
});
export type VultrInstance = z.infer<typeof VultrInstance>;

export const VultrSshKey = z.object({
  id: z.string(),
  name: z.string(),
  ssh_key: z.string(),
});
export type VultrSshKey = z.infer<typeof VultrSshKey>;

export class VultrError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
  ) {
    super(`vultr ${method} ${path}: ${status} ${message}`);
    this.name = 'VultrError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface VultrClientOptions {
  /** Absent is legal, and limits the client to `listPlans` / `listRegions`. */
  apiKey?: string | undefined;
  fetch?: FetchLike | undefined;
  baseUrl?: string | undefined;
  /** Floor between calls. 50 ms is 20/s against a documented ceiling of 30. */
  minIntervalMs?: number | undefined;
  /** Attempts per call, for the statuses `isRetryable` allows. */
  retries?: number | undefined;
  /** Attempts for a delete, which races the provider's install lock. */
  deleteRetries?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

interface CreateInstanceInput {
  region: string;
  plan: string;
  osId: number;
  label: string;
  hostname: string;
  tags: string[];
  sshKeyIds: string[];
  /** Cloud-init, sent base64 as the API requires. */
  userData: string;
}

export class VultrClient {
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly minIntervalMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextCallAtMs = 0;
  /** Serialises the gate, so concurrent callers queue rather than race it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: VultrClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? VULTR_API;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.minIntervalMs = options.minIntervalMs ?? 50;
    this.retries = options.retries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get hasKey(): boolean {
    return (this.options.apiKey ?? '').length > 0;
  }

  // --------------------------------------------------------------- catalogue

  /** Public endpoint: works without a key, which is how sizing runs early. */
  async listPlans(): Promise<VultrPlan[]> {
    return this.paged('/plans', 'plans', VultrPlan);
  }

  async listRegions(): Promise<VultrRegion[]> {
    return this.paged('/regions', 'regions', VultrRegion);
  }

  // --------------------------------------------------------------- ssh keys

  async listSshKeys(): Promise<VultrSshKey[]> {
    return this.paged('/ssh-keys', 'ssh_keys', VultrSshKey);
  }

  async createSshKey(name: string, publicKey: string): Promise<VultrSshKey> {
    const body = await this.call('POST', '/ssh-keys', { name, ssh_key: publicKey });
    return VultrSshKey.parse((body as { ssh_key: unknown }).ssh_key);
  }

  // -------------------------------------------------------------- instances

  /**
   * Every instance carrying `tag`.
   *
   * The tag is what makes teardown reliable: it lives on the provider, so
   * `destroy` finds a fleet whose local state file was lost with the laptop
   * that wrote it.
   */
  async listInstances(tag?: string): Promise<VultrInstance[]> {
    const path = tag === undefined ? '/instances' : `/instances?tag=${encodeURIComponent(tag)}`;
    return this.paged(path, 'instances', VultrInstance);
  }

  async createInstance(input: CreateInstanceInput): Promise<VultrInstance> {
    const body = await this.call('POST', '/instances', {
      region: input.region,
      plan: input.plan,
      os_id: input.osId,
      label: input.label,
      hostname: input.hostname,
      tags: input.tags,
      sshkey_id: input.sshKeyIds,
      user_data: Buffer.from(input.userData, 'utf8').toString('base64'),
      backups: 'disabled',
      enable_ipv6: false,
      // Off: it is a per-instance charge for a rig that will never restore one.
      ddos_protection: false,
    });
    return VultrInstance.parse((body as { instance: unknown }).instance);
  }

  /**
   * Idempotent by intent: a 404 means it is already gone, which is the goal.
   *
   * Given a long retry budget because of what it is for. A rollback deletes
   * instances that were created seconds earlier, and Vultr locks an instance
   * while it installs — answering `409 Server is currently locked` for the
   * first minute or so of its life. The default four attempts span under four
   * seconds and lose that race, which leaves a rolled-back fleet billing. Ten
   * attempts against the 8 s backoff cap span about fifty.
   */
  async deleteInstance(id: string): Promise<'deleted' | 'absent'> {
    try {
      await this.call('DELETE', `/instances/${encodeURIComponent(id)}`, undefined, {
        retries: this.options.deleteRetries ?? 10,
      });
      return 'deleted';
    } catch (error) {
      if (error instanceof VultrError && error.status === 404) {
        return 'absent';
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- machinery

  private async paged<T extends z.ZodTypeAny>(
    path: string,
    key: string,
    schema: T,
  ): Promise<z.infer<T>[]> {
    const out: z.infer<T>[] = [];
    let cursor = '';
    // Bounded: a runaway cursor is a bug in the provider, not a reason to spin.
    for (let page = 0; page < 32; page += 1) {
      const joiner = path.includes('?') ? '&' : '?';
      const suffix = cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const body = (await this.call('GET', `${path}${joiner}per_page=500${suffix}`)) as Record<
        string,
        unknown
      >;
      for (const item of (body[key] as unknown[]) ?? []) {
        out.push(schema.parse(item));
      }
      const next = (body['meta'] as { links?: { next?: string } } | undefined)?.links?.next ?? '';
      if (next === '') {
        break;
      }
      cursor = next;
    }
    return out;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    options?: { retries?: number },
  ): Promise<unknown> {
    // Chained rather than checked: two callers reading the same `nextCallAtMs`
    // would both find it clear and both fire.
    const run = this.queue.then(() => this.callNow(method, path, body, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async callNow(
    method: string,
    path: string,
    body?: unknown,
    options?: { retries?: number },
  ): Promise<unknown> {
    const retries = options?.retries ?? this.retries;
    let lastError: VultrError | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const wait = this.nextCallAtMs - Date.now();
      if (wait > 0) {
        await this.sleep(wait);
      }
      this.nextCallAtMs = Date.now() + this.minIntervalMs;

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.options.apiKey !== undefined) {
        headers['Authorization'] = `Bearer ${this.options.apiKey}`;
      }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (response.status === 204) {
        return {};
      }
      const text = await response.text();
      if (response.ok) {
        return text.length === 0 ? {} : (JSON.parse(text) as unknown);
      }

      const message = extractError(text);
      lastError = new VultrError(message, response.status, method, path);
      if (!isRetryable(method, response.status)) {
        throw lastError;
      }
      await this.sleep(Math.min(8_000, 250 * 2 ** attempt));
    }
    throw lastError ?? new Error(`vultr ${method} ${path}: exhausted retries`);
  }
}

/**
 * Which failures are worth re-sending.
 *
 * 4xx normally means this code got the request wrong, and re-sending a wrong
 * `POST /instances` could rent a second box — so the default is to give up. The
 * exception is a locked delete: `409 Server is currently locked` is Vultr
 * saying "not yet", DELETE is idempotent, and abandoning it leaves an instance
 * billing. That is the one 4xx this client re-sends.
 */
export function isRetryable(method: string, status: number): boolean {
  if (status === 429 || status >= 500) {
    return true;
  }
  return method === 'DELETE' && status === 409;
}

function extractError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // Not JSON. Fall through to the raw body, trimmed.
  }
  return text.slice(0, 200).trim() || 'no body';
}
