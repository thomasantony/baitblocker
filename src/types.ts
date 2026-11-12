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
}

export type Decision = 'hide' | 'blur' | 'show';

export interface Question {
  id: string;
  text: string;
}

export interface QuestionsConfig {
  version: number;
  /** Topic questions; a post's score is the highest of their probabilities. */
  questions: Question[];
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
  questionsVersion: number;
}

/** What the background returns to a tab for one post. */
export interface Verdict {
  postId: string;
  /** "unscored" when scoring was skipped (no key, budget exceeded, API error) or waits on the country. */
  decision: Decision | 'unscored';
  score?: number;
  topQuestion?: string;
  author?: string;
  reason?: 'd1' | 'cache' | 'budget' | 'no_key' | 'error' | 'country';
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
  dailyTokenBudget: number;
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
