import { describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/db';
import { Scorer } from '../src/scorer';
import { D1Client, type ScoringClient } from '../src/scoring';
import { QUESTIONS } from '../src/settings';
import type { AuthorRecord, LabelRecord, Post, PostRecord } from '../src/types';

class MemStore implements Store {
  posts = new Map<string, PostRecord>();
  authors = new Map<string, AuthorRecord>();
  labels: LabelRecord[] = [];
  async getPost(id: string) { return this.posts.get(id); }
  async putPost(p: PostRecord) { this.posts.set(p.id, p); }
  async getAuthor(h: string) { return this.authors.get(h); }
  async putAuthor(a: AuthorRecord) { this.authors.set(a.handle, { ...a }); }
  async addLabel(l: LabelRecord) { this.labels.push(l); }
}

const post = (id: string, extra: Partial<Post> = {}): Post => ({ id, text: `post ${id}`, author: 'someone', isReply: false, ...extra });

function setup(opts: { probs?: Record<string, number>; budgetLeft?: boolean; concurrency?: number } = {}) {
  const store = new MemStore();
  let active = 0;
  let maxActive = 0;
  const client: ScoringClient = {
    score: vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { probs: opts.probs ?? { slurs: 0.95 }, inputTokens: 100 };
    }),
  };
  const budget = { canSpend: vi.fn(async () => opts.budgetLeft ?? true), record: vi.fn(async () => {}) };
  const scorer = new Scorer({
    store,
    client: () => client,
    config: QUESTIONS,
    thresholds: () => ({ hide: 0.85, blur: 0.4 }),
    budget,
    concurrency: opts.concurrency ?? 2,
    flushMs: 1,
  });
  return { store, client, budget, scorer, maxActive: () => maxActive };
}

describe('Scorer', () => {
  it('scores, stores, and updates the author Beta estimate', async () => {
    const { scorer, store, budget } = setup();
    const v = await scorer.decide(post('1'));
    expect(v).toMatchObject({ decision: 'hide', reason: 'd1', topQuestion: 'slurs', author: 'someone' });
    expect(store.posts.get('1')).toMatchObject({ decision: 'hide', probs: { slurs: 0.95 }, questionsVersion: 1 });
    expect(store.authors.get('someone')).toMatchObject({ alpha: 1.95, postsSeen: 1 });
    expect(store.authors.get('someone')!.beta).toBeCloseTo(1.05);
    expect(budget.record).toHaveBeenCalledWith(100, 'hide');
  });

  it('answers cached posts without calling d1, and dedupes concurrent requests', async () => {
    const { scorer, client } = setup();
    await Promise.all([scorer.decide(post('1')), scorer.decide(post('1'))]);
    expect(await scorer.decide(post('1'))).toMatchObject({ reason: 'cache', decision: 'hide' });
    expect(client.score).toHaveBeenCalledTimes(1);
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

  it('hides seeded authors (and quotes of them) without calling d1, recording an account_seed label', async () => {
    const { scorer, client, store } = setup();
    store.authors.set('blocked', { handle: 'blocked', alpha: 1, beta: 1, seeded: true, postsSeen: 0 });
    expect(await scorer.decide(post('1', { author: '@Blocked' }))).toMatchObject({ decision: 'hide', reason: 'seeded', topQuestion: 'seeded_author' });
    expect(await scorer.decide(post('2', { quotedAuthor: 'blocked' }))).toMatchObject({ decision: 'hide', reason: 'seeded' });
    expect(client.score).not.toHaveBeenCalled();
    expect(store.labels.map((l) => [l.postId, l.source])).toEqual([['1', 'account_seed'], ['2', 'account_seed']]);
  });

  it('degrades to unscored when d1 fails', async () => {
    const { scorer, client } = setup();
    vi.mocked(client.score).mockRejectedValueOnce(new Error('boom'));
    expect(await scorer.decide(post('1'))).toMatchObject({ decision: 'unscored', reason: 'error' });
  });
});

describe('D1Client', () => {
  it('sends one state with all questions as noul and reads probabilities', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ model: 'd1.1', answers: { slurs: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 42 } })),
    );
    const c = new D1Client('liquid_test', 'd1.1', fetchImpl as unknown as typeof fetch);
    const r = await c.score(post('1', { quotedText: 'q', quotedAuthor: 'x' }), QUESTIONS.questions);
    expect(r).toEqual({ probs: { slurs: 0.7 }, inputTokens: 42 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.liquid.ai/decisions/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer liquid_test');
    const body = JSON.parse(init.body as string);
    expect(body.state).toBe('post 1\n\n[Quoting @x]\nq');
    expect(Object.keys(body.questions)).toHaveLength(5);
    expect(body.questions.slurs.type).toBe('noul');
  });
});
