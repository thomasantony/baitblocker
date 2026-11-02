import { combine } from './combine';
import { authorScore, newAuthor, normHandle, type Store } from './db';
import type { ScoringClient } from './scoring';
import type { Decision, Post, PostRecord, QuestionsConfig, Thresholds, Verdict } from './types';

export interface Budget {
  /** False once today's token budget is used up. */
  canSpend(): Promise<boolean>;
  record(inputTokens: number, decision: Decision): Promise<void>;
}

export interface ScorerOptions {
  store: Store;
  /** Returns undefined when no API key is configured. */
  client: () => ScoringClient | undefined;
  config: QuestionsConfig;
  thresholds: () => Thresholds;
  budget: Budget;
  /** Max d1 requests in flight. d1 takes one post per request, so this is the "batch size". */
  concurrency?: number;
  /** Queued posts are dispatched at least this often. */
  flushMs?: number;
}

interface Job {
  post: Post;
  resolve: (v: Verdict) => void;
}

/** Cache → seeded-author short-circuit → budget → queued d1 call → store. */
export class Scorer {
  private queue: Job[] = [];
  private inflight = new Map<string, Promise<Verdict>>();
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private concurrency: number;
  private flushMs: number;

  constructor(private o: ScorerOptions) {
    this.concurrency = o.concurrency ?? 6;
    this.flushMs = o.flushMs ?? 300;
  }

  decide(post: Post): Promise<Verdict> {
    const existing = this.inflight.get(post.id);
    if (existing) return existing;
    const p = this.decideUncached(post).finally(() => this.inflight.delete(post.id));
    this.inflight.set(post.id, p);
    return p;
  }

  private async decideUncached(post: Post): Promise<Verdict> {
    const cached = await this.o.store.getPost(post.id);
    if (cached) return this.verdictFor(cached, 'cache');

    const seededBy = await this.seededAuthor(post);
    if (seededBy) {
      const rec: PostRecord = {
        ...this.baseRecord(post),
        probs: {},
        score: 1,
        decision: 'hide',
        reason: 'seeded',
      };
      await this.o.store.putPost(rec);
      await this.o.store.addLabel({ postId: post.id, label: 'ragebait', source: 'account_seed', at: Date.now() });
      await this.bumpAuthor(post.author);
      return this.verdictFor(rec, 'seeded');
    }

    if (!this.o.client()) return { postId: post.id, decision: 'unscored', reason: 'no_key' };
    return new Promise<Verdict>((resolve) => {
      this.queue.push({ post, resolve });
      if (this.queue.length >= this.concurrency) this.flush();
      else this.timer ??= setTimeout(() => this.flush(), this.flushMs);
    });
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      this.run(job.post)
        .catch((): Verdict => ({ postId: job.post.id, decision: 'unscored', reason: 'error' }))
        .then(job.resolve)
        .finally(() => {
          this.active--;
          if (this.queue.length) this.flush();
        });
    }
  }

  private async run(post: Post): Promise<Verdict> {
    const client = this.o.client();
    if (!client) return { postId: post.id, decision: 'unscored', reason: 'no_key' };
    if (!(await this.o.budget.canSpend())) return { postId: post.id, decision: 'unscored', reason: 'budget' };
    const { probs, inputTokens } = await client.score(post, this.o.config.questions);
    const c = combine(probs, this.o.config, this.o.thresholds());
    const rec: PostRecord = { ...this.baseRecord(post), probs, score: c.score, decision: c.decision, reason: 'd1' };
    await this.o.store.putPost(rec);
    await this.o.budget.record(inputTokens, c.decision);
    await this.bumpAuthor(post.author, c.score);
    return this.verdictFor(rec, 'd1');
  }

  private baseRecord(post: Post) {
    return {
      id: post.id,
      text: post.text,
      quotedText: post.quotedText,
      author: post.author ? normHandle(post.author) : undefined,
      seenAt: Date.now(),
      questionsVersion: this.o.config.version,
    };
  }

  private async seededAuthor(post: Post): Promise<string | undefined> {
    for (const h of [post.author, post.quotedAuthor]) {
      if (!h) continue;
      const a = await this.o.store.getAuthor(normHandle(h));
      if (a?.seeded) return a.handle;
    }
    return undefined;
  }

  private async bumpAuthor(handle: string | undefined, score?: number) {
    if (!handle) return;
    const h = normHandle(handle);
    const a = (await this.o.store.getAuthor(h)) ?? newAuthor(h);
    a.postsSeen++;
    if (score !== undefined) {
      a.alpha += score;
      a.beta += 1 - score;
    }
    await this.o.store.putAuthor(a);
  }

  private async verdictFor(rec: PostRecord, reason: Verdict['reason']): Promise<Verdict> {
    // Re-derive the decision from stored probabilities so threshold edits apply to cached posts.
    const c = rec.reason === 'seeded' ? undefined : combine(rec.probs, this.o.config, this.o.thresholds());
    const author = rec.author ? await this.o.store.getAuthor(rec.author) : undefined;
    return {
      postId: rec.id,
      decision: c?.decision ?? rec.decision,
      score: c?.score ?? rec.score,
      topQuestion: rec.reason === 'seeded' ? 'seeded_author' : c?.topQuestion,
      author: rec.author,
      authorScore: author ? authorScore(author) : undefined,
      reason,
    };
  }
}
