export interface Post {
  id: string;
  text: string;
  author?: string;
  quotedText?: string;
  quotedAuthor?: string;
  /**
   * The quoted post's id when known (from X's JSON). The quoted post is then scored on its own,
   * and this post is scored without it; DOM-scraped posts lack it and are scored with the quote.
   */
  quotedId?: string;
  /** This post's own photo URLs (not the quote's when quotedId is set), sized for scoring. */
  imageUrls?: string[];
  isReply: boolean;
  /** "parser" when it came from intercepted JSON, "dom" when scraped as a fallback. */
  source?: 'parser' | 'dom';
}

export type Decision = 'hide' | 'blur' | 'show';
export type LabelValue = 'ragebait' | 'racist' | 'fine';
export type LabelSource = 'user_button' | 'show_click' | 'account_seed';

export interface Question {
  id: string;
  text: string;
}

export interface QuestionsConfig {
  version: number;
  questions: Question[];
  combine: { max_of: string[]; weighted: Record<string, number> };
  thresholds: Thresholds;
  /**
   * Asked (in a second, one-question call) only for posts that quote a post scoring at least the blur
   * threshold. At or above `threshold`, the quoting post inherits the quoted post's score.
   */
  stance?: Question & { threshold: number };
}

export interface Thresholds {
  hide: number;
  blur: number;
}

export interface PostRecord {
  id: string;
  text: string;
  quotedText?: string;
  quotedId?: string;
  /** P(author endorses the quoted post), once asked. */
  endorsesQuote?: number;
  author?: string;
  seenAt: number;
  probs: Record<string, number>;
  score: number;
  decision: Decision;
  questionsVersion: number;
  /** "seeded" when decided by the account seed list, "d1" when scored. */
  reason?: 'seeded' | 'd1';
}

export interface LabelRecord {
  id?: number;
  postId: string;
  label: LabelValue;
  source: LabelSource;
  at: number;
}

export interface AuthorRecord {
  handle: string;
  alpha: number;
  beta: number;
  seeded: boolean;
  seedText?: string;
  postsSeen: number;
}

/** What the background returns to a tab for one post. */
export interface Verdict {
  postId: string;
  /** "unscored" when scoring was skipped (no key, budget exceeded, API error). */
  decision: Decision | 'unscored';
  score?: number;
  topQuestion?: string;
  author?: string;
  authorScore?: number;
  reason?: 'seeded' | 'd1' | 'cache' | 'budget' | 'no_key' | 'error' | 'country';
  /** The author's "Account based in" value, when known. */
  country?: string;
  /** Set (with decision "unscored") when the topic fired and the author's country must be looked up first. */
  needsCountry?: string;
}

/** Cached "About this account" result. `country` is undefined when X returned nothing. */
export interface CountryRecord {
  handle: string;
  country?: string;
  /** X's location_accurate flag (false hints at a VPN/proxy). */
  accurate?: boolean;
  fetchedAt: number;
}

export interface Settings {
  apiKey: string;
  model: string;
  thresholds: Thresholds;
  enabled: { pending: boolean; hide: boolean; blur: boolean };
  dailyTokenBudget: number;
  captureFixtures: boolean;
  /** "Account based in" values whose posts are never filtered (case-insensitive). */
  allowedCountries: string[];
  /** Send attached photos to d1 along with the text. */
  scoreImages: boolean;
}

export interface Usage {
  date: string;
  tokens: number;
  scored: number;
  decisions: Record<Decision, number>;
}

export const MSG_NS = 'baitblocker:v1';
