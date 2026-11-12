import { describe, expect, it, vi } from 'vitest';
import { CountryFetcher, aboutQueryId, isAllowed, parseAbout } from '../src/country';

// Trimmed real AboutAccountQuery response (2026-11-11).
const REAL = {
  data: {
    user_result_by_screen_name: {
      id: 'x',
      result: {
        __typename: 'User',
        about_profile: { account_based_in: 'South Asia', created_country_accurate: true, location_accurate: false, source: 'Europe App Store' },
        core: { screen_name: 'Mr_Husky1' },
      },
    },
  },
};

describe('parseAbout', () => {
  it('reads account_based_in and location_accurate', () => {
    expect(parseAbout(REAL)).toEqual({ country: 'South Asia', accurate: false });
  });
  it('tolerates missing data', () => {
    expect(parseAbout({ data: {} })).toEqual({});
    expect(parseAbout(null)).toEqual({});
    expect(parseAbout({ about_profile: {} })).toEqual({ country: undefined, accurate: undefined });
  });
});

it('isAllowed is case-insensitive and false for unknown', () => {
  expect(isAllowed('united states', ['United States'])).toBe(true);
  expect(isAllowed('Kenya', ['United States'])).toBe(false);
  expect(isAllowed(undefined, ['United States'])).toBe(false);
});

it('aboutQueryId extracts the id from X URLs', () => {
  expect(aboutQueryId('https://x.com/i/api/graphql/TzOG2twZEfhr9KmClvVVqA/AboutAccountQuery?variables=%7B%7D')).toBe('TzOG2twZEfhr9KmClvVVqA');
  expect(aboutQueryId('https://x.com/i/api/graphql/abc/HomeTimeline')).toBeUndefined();
});

describe('CountryFetcher', () => {
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it('dedupes, waits out 429s until reset, and parses results', async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, {}, { 'x-rate-limit-reset': String((now + 60_000) / 1000) }))
      .mockResolvedValueOnce(res(200, REAL, { 'x-rate-limit-remaining': '40' }));
    const f = new CountryFetcher({
      fetch: fetchImpl,
      queryId: () => 'QID',
      headers: () => ({}),
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const [a, b] = await Promise.all([f.lookup('Mr_Husky1'), f.lookup('mr_husky1')]);
    expect(a).toEqual({ ok: true, info: { country: 'South Asia', accurate: false } });
    expect(b).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/graphql/QID/AboutAccountQuery?variables=');
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('reports a stale query id on 404', async () => {
    const f = new CountryFetcher({ fetch: vi.fn().mockResolvedValue(res(404, {})), queryId: () => 'old', headers: () => ({}), sleep: async () => {} });
    expect(await f.lookup('a')).toEqual({ ok: false, error: 'stale_query' });
  });
});
