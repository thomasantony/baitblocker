import { combine, type Combined } from './combine';
import { isAllowed, isFresh } from './country';
import { authorScore, newAuthor, normHandle, type Store } from './db';
import type { ScoringClient } from './scoring';
import type { Decision, Post, PostRecord, QuestionsConfig, Thresholds, Verdict } from './types';

export interface Budget {
  /** False once today's token budget is used up. */
  canSpend(): Promise<boolean>;
  record(inputTokens: number, decision?: Decision): Promise<void>;
}

export interface ScorerOptions {
  store: Store;
  /** Returns undefined when no API key is configured. */
  client: () => ScoringClient | undefined;
  config: QuestionsConfig;
  thresholds: () => Thresholds;
  /** "Account based in" values that are never filtered. */
  allowedCountries?: () => string[];
  /** Loads a post's photos as data URLs; omit or return [] to score text only. */
  images?: (post: Post) => Promise<string[]>;
  budget: Budget;
  /** Max d1 requests in flight. d1 takes one post per request, so this is the "batch size". */
  concurrency?: number;
  /** Queued posts are dispatched at least this often. */
  flushMs?: number;
}

interface Job {
  post: Post;
  /** True when re-scoring a post cached under older questions; the author was already counted. */
  rescore: boolean;
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
    // Seeded decisions don't depend on the questions; d1 scores do, so re-score when the question set changed.
    if (cached && (cached.reason === 'seeded' || cached.questionsVersion === this.o.config.version)) {
      return this.verdictFor(cached, 'cache');
    }

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

    // Authors already known to be based in an allowed country never need d1.
    const country = post.author ? await this.o.store.getCountry(normHandle(post.author)) : undefined;
    if (isFresh(country) && isAllowed(country.country, this.allowed())) {
      return { postId: post.id, decision: 'show', reason: 'country', author: normHandle(post.author!), country: country.country };
    }

    if (!this.o.client()) return { postId: post.id, decision: 'unscored', reason: 'no_key' };
    return new Promise<Verdict>((resolve) => {
      this.queue.push({ post, rescore: !!cached, resolve });
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
      this.run(job.post, job.rescore)
        .catch((): Verdict => ({ postId: job.post.id, decision: 'unscored', reason: 'error' }))
        .then(job.resolve)
        .finally(() => {
          this.active--;
          if (this.queue.length) this.flush();
        });
    }
  }

  private async run(post: Post, rescore: boolean): Promise<Verdict> {
    const client = this.o.client();
    if (!client) return { postId: post.id, decision: 'unscored', reason: 'no_key' };
    if (!(await this.o.budget.canSpend())) return { postId: post.id, decision: 'unscored', reason: 'budget' };
    // A failed image download degrades to text-only scoring.
    const images = post.imageUrls?.length && this.o.images ? await this.o.images(post).catch(() => []) : [];
    const { probs, inputTokens } = await client.score(post, this.o.config.questions, images);
    const c = combine(probs, this.o.config, this.o.thresholds());
    const rec: PostRecord = { ...this.baseRecord(post), probs, score: c.score, decision: c.decision, reason: 'd1' };
    await this.o.store.putPost(rec);
    await this.o.budget.record(inputTokens, c.decision);
    if (!rescore) await this.bumpAuthor(post.author, c.score);
    return this.verdictFor(rec, 'd1');
  }

  /**
   * A post that endorses a bait quote ("this 👆 so true") inherits the quote's score. The stance is
   * only asked once the quoted post has been scored as bait; until then the post's own score stands
   * (the content script re-asks when the quote's verdict arrives).
   */
  private async withEndorsedQuote(rec: PostRecord, own: Combined): Promise<Combined> {
    const stance = this.o.config.stance;
    if (!stance || !rec.quotedId || !rec.quotedText) return own;
    const quoted = await this.o.store.getPost(rec.quotedId);
    if (!quoted || quoted.questionsVersion !== this.o.config.version) return own;
    const t = this.o.thresholds();
    const q = quoted.reason === 'seeded' ? { score: 1, decision: 'hide' as const } : combine(quoted.probs, this.o.config, t);
    if (q.score < t.blur || q.score <= own.score) return own;
    if (rec.endorsesQuote === undefined) {
      const p = await this.askStance(rec).catch(() => undefined);
      if (p === undefined) return own;
      rec.endorsesQuote = p;
      await this.o.store.putPost(rec);
    }
    if (rec.endorsesQuote >= stance.threshold) return { score: q.score, decision: q.decision, topQuestion: 'endorses_quote' };
    // Replying against a bait quote ("engagement bait, don't reply"): short rebuttals read as bait-ish out of
    // context, so the author's own words only count when they clear the hide threshold on their own.
    return own.decision === 'hide' ? own : { ...own, decision: 'show' };
  }

  private async askStance(rec: PostRecord): Promise<number | undefined> {
    const client = this.o.client();
    const stance = this.o.config.stance!;
    if (!client || !(await this.o.budget.canSpend())) return undefined;
    const state = { id: rec.id, text: `${rec.text}\n\n[Quoted post]\n${rec.quotedText}`, isReply: false };
    const { probs, inputTokens } = await client.score(state, [stance]);
    await this.o.budget.record(inputTokens);
    return probs[stance.id];
  }

  private allowed(): string[] {
    return this.o.allowedCountries?.() ?? ['United States'];
  }

  private baseRecord(post: Post) {
    return {
      id: post.id,
      text: post.text,
      quotedText: post.quotedText,
      quotedId: post.quotedId,
      author: post.author ? normHandle(post.author) : undefined,
      seenAt: Date.now(),
      questionsVersion: this.o.config.version,
    };
  }

  private async seededAuthor(post: Post): Promise<string | undefined> {
    // A quote with a known id is decided on its own (and only its box is blurred).
    for (const h of [post.author, post.quotedId ? undefined : post.quotedAuthor]) {
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
    const c = rec.reason === 'seeded' ? undefined : await this.withEndorsedQuote(rec, combine(rec.probs, this.o.config, this.o.thresholds()));
    const author = rec.author ? await this.o.store.getAuthor(rec.author) : undefined;
    const v: Verdict = {
      postId: rec.id,
      decision: c?.decision ?? rec.decision,
      score: c?.score ?? rec.score,
      topQuestion: rec.reason === 'seeded' ? 'seeded_author' : c?.topQuestion,
      author: rec.author,
      authorScore: author ? authorScore(author) : undefined,
      reason,
    };
    // The topic fired: only filter when the author is based outside the allowed countries.
    if (c && v.decision !== 'show') {
      if (!rec.author) return { ...v, decision: 'show' };
      const country = await this.o.store.getCountry(rec.author);
      if (!isFresh(country)) return { ...v, decision: 'unscored', needsCountry: rec.author };
      v.country = country.country;
      if (!country.country || isAllowed(country.country, this.allowed())) v.decision = 'show';
    }
    return v;
  }
}
