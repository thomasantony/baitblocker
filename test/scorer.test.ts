import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/db';
import { Scorer } from '../src/scorer';
import { D1Client, type ScoreResult, type ScoringClient } from '../src/scoring';
import { QUESTIONS } from '../src/settings';
import type { CountryRecord, Post, PostRecord } from '../src/types';

class MemStore implements Store {
  posts = new Map<string, PostRecord>();
  async getPost(id: string) { return this.posts.get(id); }
  async putPost(p: PostRecord) { this.posts.set(p.id, p); }
  countries = new Map<string, CountryRecord>();
  async getCountry(h: string) { return this.countries.get(h); }
  async putCountry(c: CountryRecord) { this.countries.set(c.handle, c); }
}

const based = (store: MemStore, handle: string, country?: string, fetchedAt = Date.now()) =>
  store.countries.set(handle, { handle, country, fetchedAt });

const post = (id: string, extra: Partial<Post> = {}): Post => ({ id, text: `post ${id}`, author: 'someone', ...extra });

function setup(opts: { probs?: Record<string, number>; budgetLeft?: boolean; concurrency?: number; country?: string | null; images?: (p: Post) => Promise<string[]> } = {}) {
  const store = new MemStore();
  // Most tests want the topic decision applied, so default the author to a non-US country.
  if (opts.country !== null) based(store, 'someone', opts.country ?? 'South Asia');
  let active = 0;
  let maxActive = 0;
  const client: ScoringClient = {
    score: vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { probs: opts.probs ?? { us_politics: 0.95 }, inputTokens: 100 };
    }),
  };
  const budget = { canSpend: vi.fn(async () => opts.budgetLeft ?? true), record: vi.fn(async () => {}) };
  const scorer = new Scorer({
    store,
    client: () => client,
    config: QUESTIONS,
    thresholds: () => ({ hide: 0.85, blur: 0.4 }),
    allowedCountries: () => ['United States'],
    budget,
    concurrency: opts.concurrency ?? 2,
    flushMs: 1,
    images: opts.images,
  });
  return { store, client, budget, scorer, maxActive: () => maxActive };
}

describe('Scorer', () => {
  it('scores and stores the probabilities', async () => {
    const { scorer, store, budget } = setup();
    const v = await scorer.decide(post('1'));
    expect(v).toMatchObject({ decision: 'hide', reason: 'd1', topQuestion: 'us_politics', country: 'South Asia', author: 'someone' });
    expect(store.posts.get('1')).toMatchObject({ probs: { us_politics: 0.95 }, questionsVersion: QUESTIONS.version });
    expect(budget.record).toHaveBeenCalledWith(100, 'hide');
  });

  it('answers cached posts without calling d1, and dedupes concurrent requests', async () => {
    const { scorer, client } = setup();
    await Promise.all([scorer.decide(post('1')), scorer.decide(post('1'))]);
    expect(await scorer.decide(post('1'))).toMatchObject({ reason: 'cache', decision: 'hide' });
    expect(client.score).toHaveBeenCalledTimes(1);
  });

  it('re-scores posts cached under an older question set', async () => {
    const { scorer, client, store } = setup();
    await scorer.decide(post('1'));
    store.posts.get('1')!.questionsVersion = QUESTIONS.version - 1;
    expect(await scorer.decide(post('1'))).toMatchObject({ reason: 'd1' });
    expect(client.score).toHaveBeenCalledTimes(2);
    expect(store.posts.get('1')!.questionsVersion).toBe(QUESTIONS.version);
  });

  it('limits requests in flight to the batch size', async () => {
    const { scorer, client, maxActive } = setup({ concurrency: 2 });
    await Promise.all(['1', '2', '3', '4', '5'].map((id) => scorer.decide(post(id))));
    expect(client.score).toHaveBeenCalledTimes(5);
    expect(maxActive()).toBe(2);
  });

  it('stops scoring when the budget is exhausted', async () => {
    const { scorer, client } = setup({ budgetLeft: false });
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'unscored', reason: 'budget' });
    expect(client.score).not.toHaveBeenCalled();
  });

  it('asks for the author country when the topic fires and the country is unknown', async () => {
    const { scorer } = setup({ country: null });
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'unscored', needsCountry: 'someone' });
  });

  it('only looks up the country for hide-level posts; blur-level posts use the cache or are shown', async () => {
    const { scorer, store } = setup({ country: null, probs: { us_politics: 0.6 } });
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'show' });
    expect((await scorer.decide(post('1'))).needsCountry).toBeUndefined();
    based(store, 'someone', 'Kenya');
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'blur', country: 'Kenya' });
  });

  it('re-asks after the country arrives, answering from cache', async () => {
    const { scorer, store, client } = setup({ country: null });
    await scorer.decide(post('1'));
    based(store, 'someone', 'Kenya');
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'hide', reason: 'cache', country: 'Kenya' });
    expect(client.score).toHaveBeenCalledTimes(1);
  });

  it('shows on-topic posts from US-based authors', async () => {
    const { scorer } = setup({ country: null });
    await scorer.decide(post('1'));
    const { scorer: s2, store } = setup({ country: 'United States' });
    expect(await s2.decide(post('1'))).toMatchObject({ decision: 'show', reason: 'country' });
    expect(store.posts.size).toBe(0);
    void scorer;
  });

  it('skips d1 entirely for authors known to be US-based', async () => {
    const { scorer, client } = setup({ country: 'United States' });
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'show', reason: 'country' });
    expect(client.score).not.toHaveBeenCalled();
  });

  it('does not look up the country for off-topic posts', async () => {
    const { scorer } = setup({ country: null, probs: { us_politics: 0.1, ideology_bait: 0.2 } });
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'show' });
  });

  it('shows on-topic posts when X has no country for the author, and re-looks up stale entries', async () => {
    const { scorer, store } = setup({ country: null });
    based(store, 'someone', undefined);
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'show' });
    based(store, 'someone', 'Kenya', Date.now() - 40 * 24 * 3600_000);
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'unscored', needsCountry: 'someone' });
  });

  it('passes loaded images to d1, and falls back to text when loading fails', async () => {
    const images = vi.fn(async (p: Post) => (p.id === '1' ? ['data:image/jpeg;base64,AA=='] : Promise.reject(new Error('404'))));
    const { scorer, client } = setup({ images });
    await scorer.decide(post('1', { imageUrls: ['https://pbs.twimg.com/media/a?format=jpg&name=360x360'] }));
    expect(await scorer.decide(post('2', { imageUrls: ['u'] }))).toMatchObject({ reason: 'd1' });
    await scorer.decide(post('3'));
    expect(vi.mocked(client.score).mock.calls.map((c) => c[2])).toEqual([['data:image/jpeg;base64,AA=='], [], []]);
    expect(images).toHaveBeenCalledTimes(2);
  });

  it('degrades to unscored when d1 fails', async () => {
    const { scorer, client } = setup();
    vi.mocked(client.score).mockRejectedValueOnce(new Error('boom'));
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'unscored', reason: 'error' });
  });
});

describe('quote endorsement', () => {
  /** d1 mock: the quoted post "9" is bait; quoting posts' own text is not; stance from `endorse`. */
  function quoteSetup(endorse: number) {
    const store = new MemStore();
    based(store, 'quoter', 'South Asia');
    const client: ScoringClient = {
      score: vi.fn(async (p: Post, qs: { id: string }[]): Promise<ScoreResult> => {
        if (qs.length === 1 && qs[0].id === 'endorses_quote') return { probs: { endorses_quote: endorse }, inputTokens: 30 };
        return { probs: p.id === '9' ? { ideology_bait: 0.97 } : { ideology_bait: 0.1 }, inputTokens: 100 };
      }),
    };
    const budget = { canSpend: vi.fn(async () => true), record: vi.fn(async () => {}) };
    const scorer = new Scorer({ store, client: () => client, config: QUESTIONS, thresholds: () => ({ hide: 0.8, blur: 0.5 }), allowedCountries: () => ['United States'], budget, flushMs: 1 });
    const quoting = post('1', { author: 'quoter', text: 'This 👆 so true', quotedId: '9', quotedText: 'You don’t hate socialism...', quotedAuthor: 'baiter' });
    return { store, client, budget, scorer, quoting };
  }

  it('a post endorsing a bait quote inherits its score (stance asked once, then cached)', async () => {
    const { scorer, client, budget, store, quoting } = quoteSetup(0.99);
    await scorer.decide(post('9', { author: 'baiter' }));
    expect(await scorer.decide(quoting)).toMatchObject({ decision: 'hide', topQuestion: 'endorses_quote', country: 'South Asia' });
    expect(store.posts.get('1')!.endorsesQuote).toBe(0.99);
    expect(await scorer.decide(quoting)).toMatchObject({ decision: 'hide', reason: 'cache' });
    expect(vi.mocked(client.score).mock.calls.filter((c) => c[1].length === 1)).toHaveLength(1);
    expect(budget.record).toHaveBeenCalledWith(30);
    const stanceState = vi.mocked(client.score).mock.calls.find((c) => c[1].length === 1)![0].text;
    expect(stanceState).toBe('This 👆 so true\n\n[Quoted post]\nYou don’t hate socialism...');
  });

  it('a post criticizing a bait quote is shown unless its own words clear the hide threshold', async () => {
    const { scorer, client, quoting } = quoteSetup(0.3);
    await scorer.decide(post('9', { author: 'baiter' }));
    // Own text 0.6 would normally blur a foreign author; against a bait quote it is shown.
    vi.mocked(client.score).mockImplementationOnce(async () => ({ probs: { ideology_bait: 0.6 }, inputTokens: 1 }));
    expect(await scorer.decide(quoting)).toMatchObject({ decision: 'show' });
    vi.mocked(client.score).mockImplementationOnce(async () => ({ probs: { ideology_bait: 0.9 }, inputTokens: 1 }));
    expect(await scorer.decide({ ...quoting, id: '3' })).toMatchObject({ decision: 'hide', topQuestion: 'ideology_bait' });
  });

  it('does not ask the stance until the quote is scored, nor when the quote is not bait', async () => {
    const { scorer, client, quoting } = quoteSetup(0.99);
    expect(await scorer.decide(quoting)).toMatchObject({ decision: 'show' });
    await scorer.decide(post('8', { author: 'x' })); // not bait
    expect(await scorer.decide({ ...quoting, id: '2', quotedId: '8' })).toMatchObject({ decision: 'show' });
    expect(vi.mocked(client.score).mock.calls.filter((c) => c[1].length === 1)).toHaveLength(0);
    // Once the quote is scored, re-asking the quoting post (from cache) picks it up.
    await scorer.decide(post('9', { author: 'baiter' }));
    expect(await scorer.decide(quoting)).toMatchObject({ decision: 'hide', reason: 'cache' });
  });
});

describe('D1Client', () => {
  it('sends one state with all questions as noul and reads probabilities', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ model: 'd1.1', answers: { slurs: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 42 } })),
    );
    const c = new D1Client('liquid_test', 'd1.1', fetchImpl as unknown as typeof fetch);
    const r = await c.score(post('1', { quotedText: 'q', quotedAuthor: 'x' }), QUESTIONS.questions);
    expect(r).toEqual({ probs: {}, inputTokens: 42 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.liquid.ai/decisions/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer liquid_test');
    const body = JSON.parse(init.body as string);
    expect(body.state).toBe('post 1\n\n[Quoting @x]\nq');
    // With a known quote id the quote is scored separately and left out of this post's state.
    await c.score(post('2', { quotedText: 'q', quotedAuthor: 'x', quotedId: '3' }), QUESTIONS.questions);
    expect(JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).state).toBe('post 2');
    expect(Object.keys(body.questions)).toHaveLength(QUESTIONS.questions.length);
    expect(body.questions.us_politics.type).toBe('noul');
  });
});
