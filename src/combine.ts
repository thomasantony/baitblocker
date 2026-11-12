import type { Decision, Thresholds } from './types';

export interface Combined {
  score: number;
  decision: Decision;
  /** Question with the highest probability, used to name the reason in the UI. */
  topQuestion?: string;
}

export function decide(score: number, t: Thresholds): Decision {
  if (score >= t.hide) return 'hide';
  if (score >= t.blur) return 'blur';
  return 'show';
}

/** The score is the highest probability among the topic questions; missing answers count as 0. */
export function combine(probs: Record<string, number>, questionIds: string[], t: Thresholds): Combined {
  let score = 0;
  let topQuestion: string | undefined;
  for (const q of questionIds) {
    const p = probs[q] ?? 0;
    if (topQuestion === undefined || p > score) [score, topQuestion] = [p, q];
  }
  return { score, decision: decide(score, t), topQuestion: score > 0 ? topQuestion : undefined };
}
