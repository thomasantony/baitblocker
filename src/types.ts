export interface Post {
  id: string;
  text: string;
  author?: string;
  quotedText?: string;
  quotedAuthor?: string;
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
}

export interface Thresholds {
  hide: number;
  blur: number;
}

export interface PostRecord {
  id: string;
  text: string;
  quotedText?: string;
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
  reason?: 'seeded' | 'd1' | 'cache' | 'budget' | 'no_key' | 'error';
}

export interface Settings {
  apiKey: string;
  model: string;
  thresholds: Thresholds;
  enabled: { pending: boolean; hide: boolean; blur: boolean; flag: boolean };
  dailyTokenBudget: number;
  captureFixtures: boolean;
}

export interface Usage {
  date: string;
  tokens: number;
  scored: number;
  decisions: Record<Decision, number>;
}

export const MSG_NS = 'rbf:v0';
