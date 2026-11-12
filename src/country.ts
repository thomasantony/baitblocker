import type { CountryRecord } from './types';

export const ABOUT_OP = 'AboutAccountQuery';
/** Query ID observed 2026-11-11; refreshed automatically from X's own traffic when it rotates. */
export const DEFAULT_ABOUT_QUERY_ID = 'TzOG2twZEfhr9KmClvVVqA';
/** X web client's public bearer token; replaced by whatever X itself sends when observed. */
export const DEFAULT_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const KNOWN_TTL_MS = 30 * 24 * 3600_000;
export const UNKNOWN_TTL_MS = 24 * 3600_000;

export interface AboutInfo {
  country?: string;
  accurate?: boolean;
}

/** Finds `about_profile` anywhere in an AboutAccountQuery response. Never throws. */
export function parseAbout(json: unknown): AboutInfo {
  const stack: unknown[] = [json];
  while (stack.length) {
    const n = stack.pop();
    if (typeof n !== 'object' || n === null) continue;
    const about = (n as any).about_profile;
    if (about && typeof about === 'object') {
      const c = about.account_based_in;
      return {
        country: typeof c === 'string' && c.trim() ? c.trim() : undefined,
        accurate: typeof about.location_accurate === 'boolean' ? about.location_accurate : undefined,
      };
    }
    stack.push(...Object.values(n));
  }
  return {};
}

export function isFresh(r: CountryRecord | undefined, now = Date.now()): r is CountryRecord {
  if (!r) return false;
  return now - r.fetchedAt < (r.country ? KNOWN_TTL_MS : UNKNOWN_TTL_MS);
}

export function isAllowed(country: string | undefined, allowed: string[]): boolean {
  if (!country) return false;
  const c = country.toLowerCase();
  return allowed.some((a) => a.trim().toLowerCase() === c);
}

export function aboutQueryId(url: string): string | undefined {
  return new RegExp(`/graphql/([^/]+)/${ABOUT_OP}\\b`).exec(url)?.[1];
}

export type LookupResult = { ok: true; info: AboutInfo } | { ok: false; error: string };

export interface FetcherDeps {
  fetch: typeof fetch;
  queryId: () => string;
  headers: () => Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between requests. */
  gapMs?: number;
}

/**
 * One request at a time, newest request first, spaced out, pausing until X's rate-limit reset when the
 * window (50 per 15 min at the time of writing) is nearly used up.
 */
export class CountryFetcher {
  private queue: { handle: string; resolve: (r: LookupResult) => void }[] = [];
  private pending = new Map<string, Promise<LookupResult>>();
  private running = false;
  private resumeAt = 0;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private d: FetcherDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  lookup(handle: string): Promise<LookupResult> {
    const key = handle.toLowerCase();
    const existing = this.pending.get(key);
    if (existing) return existing;
    const p = new Promise<LookupResult>((resolve) => this.queue.push({ handle, resolve }));
    this.pending.set(key, p);
    p.finally(() => this.pending.delete(key));
    this.pump();
    return p;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const wait = this.resumeAt - this.now();
        if (wait > 0) await this.sleep(wait);
        // Newest first: the posts the user just scrolled to matter more than ones scrolled past.
        const job = this.queue.pop()!;
        const r = await this.once(job.handle);
        if (!r.ok && r.error === 'rate_limited') {
          this.queue.push(job);
          continue;
        }
        job.resolve(r);
        this.resumeAt = Math.max(this.resumeAt, this.now() + (this.d.gapMs ?? 1000));
      }
    } finally {
      this.running = false;
    }
  }

  private async once(handle: string): Promise<LookupResult> {
    const url = `/i/api/graphql/${this.d.queryId()}/${ABOUT_OP}?variables=${encodeURIComponent(JSON.stringify({ screenName: handle }))}`;
    let res: Response;
    try {
      res = await this.d.fetch(url, { credentials: 'include', headers: this.d.headers() });
    } catch (e) {
      return { ok: false, error: 'network' };
    }
    const remaining = Number(res.headers.get('x-rate-limit-remaining'));
    const reset = Number(res.headers.get('x-rate-limit-reset')) * 1000;
    const resetAt = reset > this.now() ? reset + 1000 : this.now() + 60_000;
    if (res.status === 429) {
      this.resumeAt = resetAt;
      return { ok: false, error: 'rate_limited' };
    }
    // Keep a little headroom so X's own About pages still work.
    if (Number.isFinite(remaining) && res.headers.has('x-rate-limit-remaining') && remaining <= 2) this.resumeAt = resetAt;
    if (res.status === 400 || res.status === 404) return { ok: false, error: 'stale_query' };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    try {
      return { ok: true, info: parseAbout(await res.json()) };
    } catch {
      return { ok: false, error: 'bad_json' };
    }
  }
}
