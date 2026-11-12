import { combine, type Combined } from './combine';
import { isAllowed, isFresh } from './country';
import { normHandle, type Store } from './db';
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
  allowedCountries: () => string[];
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
  resolve: (v: Verdict) => void;
}

/** Cache → allowed-country short-circuit → budget → queued d1 call → store → country gate. */
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
    // Scores depend on the questions, so posts cached under an older question set are scored again.
    const cached = await this.o.store.getPost(post.id);
    if (cached?.questionsVersion === this.o.config.version) return this.verdictFor(cached, 'cache');

    // Authors already known to be based in an allowed country never need d1.
    const author = post.author ? normHandle(post.author) : undefined;
    const country = author ? await this.o.store.getCountry(author) : undefined;
    if (isFresh(country) && isAllowed(country.country, this.o.allowedCountries())) {
      return { postId: post.id, decision: 'show', reason: 'country', author, country: country.country };
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
    // A failed image download degrades to text-only scoring.
    const images = post.imageUrls?.length && this.o.images ? await this.o.images(post).catch(() => []) : [];
    const { probs, inputTokens } = await client.score(post, this.o.config.questions, images);
    const rec: PostRecord = {
      id: post.id,
      text: post.text,
      quotedText: post.quotedText,
      quotedId: post.quotedId,
      author: post.author ? normHandle(post.author) : undefined,
      seenAt: Date.now(),
      probs,
      questionsVersion: this.o.config.version,
    };
    await this.o.store.putPost(rec);
    await this.o.budget.record(inputTokens, this.topic(rec).decision);
    return this.verdictFor(rec, 'd1');
  }

  /** Derived from stored probabilities on every ask, so threshold edits apply to cached posts. */
  private topic(rec: PostRecord): Combined {
    return combine(rec.probs, this.o.config.questions.map((q) => q.id), this.o.thresholds());
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
    const q = this.topic(quoted);
    if (q.score < this.o.thresholds().blur || q.score <= own.score) return own;
    if (rec.endorsesQuote === undefined) {
      const p = await this.askStance(rec).catch(() => undefined);
      if (p === undefined) return own;
      rec.endorsesQuote = p;
      await this.o.store.putPost(rec);
    }
    if (rec.endorsesQuote >= stance.threshold) return { score: q.score, decision: q.decision, topQuestion: stance.id };
    // Replying against a bait quote ("engagement bait, don't reply"): short rebuttals read as bait-ish out of
    // context, so the author's own words only count when they clear the hide threshold on their own.
    return own.decision === 'hide' ? own : { ...own, decision: 'show' };
  }

  private async askStance(rec: PostRecord): Promise<number | undefined> {
    const client = this.o.client();
    const stance = this.o.config.stance!;
    if (!client || !(await this.o.budget.canSpend())) return undefined;
    const state: Post = { id: rec.id, text: `${rec.text}\n\n[Quoted post]\n${rec.quotedText}` };
    const { probs, inputTokens } = await client.score(state, [stance]);
    await this.o.budget.record(inputTokens);
    return probs[stance.id];
  }

  private async verdictFor(rec: PostRecord, reason: Verdict['reason']): Promise<Verdict> {
    const c = await this.withEndorsedQuote(rec, this.topic(rec));
    const v: Verdict = { postId: rec.id, decision: c.decision, score: c.score, topQuestion: c.topQuestion, author: rec.author, reason };
    if (v.decision === 'show') return v;
    // The topic fired: only filter when the author is based outside the allowed countries.
    if (!rec.author) return { ...v, decision: 'show' };
    const country = await this.o.store.getCountry(rec.author);
    if (!isFresh(country)) {
      // X allows ~50 lookups per 15 min, so only hide-level posts are worth one; blur-level posts from
      // authors not already cached are shown.
      if (v.decision === 'hide') return { ...v, decision: 'unscored', needsCountry: rec.author };
      return { ...v, decision: 'show' };
    }
    v.country = country.country;
    if (!country.country || isAllowed(country.country, this.o.allowedCountries())) v.decision = 'show';
    return v;
  }
}
