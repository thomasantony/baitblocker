import type { Post, Question } from './types';

export interface ScoreResult {
  probs: Record<string, number>;
  inputTokens: number;
}

export interface ScoringClient {
  score(post: Post, questions: Question[]): Promise<ScoreResult>;
}

export const D1_ENDPOINT = 'https://api.liquid.ai/decisions/v1/systemone';

/** Text sent to the model as `state`. */
export function postToState(post: Post): string {
  let s = post.text;
  if (post.quotedText) s += `\n\n[Quoting${post.quotedAuthor ? ' @' + post.quotedAuthor : ''}]\n${post.quotedText}`;
  return s;
}

/**
 * Liquid AI d1 (https://docs.liquid.ai/lfm/models/d1). One `state` per request; all
 * questions go in one call as `noul` (yes/no) questions, each answered with P(yes).
 */
export class D1Client implements ScoringClient {
  constructor(
    private apiKey: string,
    private model = 'd1.1',
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async score(post: Post, questions: Question[]): Promise<ScoreResult> {
    const body = {
      model: this.model,
      state: postToState(post),
      questions: Object.fromEntries(questions.map((q) => [q.id, { type: 'noul', instructions: q.text }])),
    };
    const res = await this.fetchImpl(D1_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`d1 HTTP ${res.status}`);
    const json: any = await res.json();
    const probs: Record<string, number> = {};
    for (const q of questions) {
      const a = json?.answers?.[q.id];
      if (typeof a?.noul === 'number') probs[q.id] = a.noul;
    }
    return { probs, inputTokens: Number(json?.usage?.input_tokens) || 0 };
  }
}
