import type { Post, Question } from './types';

export interface ScoreResult {
  probs: Record<string, number>;
  inputTokens: number;
}

export interface ScoringClient {
  /** `images` are base64 data URLs (d1 does not accept remote URLs). */
  score(post: Post, questions: Question[], images?: string[]): Promise<ScoreResult>;
}

export const D1_ENDPOINT = 'https://api.liquid.ai/decisions/v1/systemone';

/** Text sent to the model as `state`. A quote with a known id is scored on its own, so it is left out. */
export function postToState(post: Post): string {
  let s = post.text;
  if (post.quotedText && !post.quotedId) s += `\n\n[Quoting${post.quotedAuthor ? ' @' + post.quotedAuthor : ''}]\n${post.quotedText}`;
  return s;
}

/** Fetches an image and returns it as a data URL. */
export async function imageToDataUrl(url: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const type = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
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

  async score(post: Post, questions: Question[], images: string[] = []): Promise<ScoreResult> {
    const body = {
      model: this.model,
      state: postToState(post),
      ...(images.length ? { images } : {}),
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
